import chalk from "chalk";
import fs from "fs-extra";
import http from "http";
import https from "https";
import yaml from "js-yaml";
import path from "path";

/**
 * A server that proxies or replays requests depending on the mode.
 */
export class RecordReplayServer {
  private server: http.Server;

  private mode: Mode;
  private tapeDir: string;
  private proxiedHost?: string;
  private currentTapeRecords: TapeRecord[] = [];
  private currentTape!: string;

  constructor(options: { mode: Mode; tapeDir: string; host?: string }) {
    this.currentTapeRecords = [];
    this.mode = options.mode;
    this.tapeDir = options.tapeDir;
    this.proxiedHost = options.host;
    this.loadTape(DEFAULT_TAPE);

    this.server = http.createServer(async (req, res) => {
      if (!req.url) {
        console.error(chalk.red("Received a request without URL."));
        return;
      }
      if (!req.method) {
        console.error(chalk.red("Received a request without HTTP method."));
        return;
      }

      try {
        const requestBody = await receiveRequestBody(req);
        const requestPath = extractPath(req.url);

        if (requestPath.startsWith("/__proxay/")) {
          this.handleProxayApi(requestPath, requestBody, res);
          return;
        }

        let record: TapeRecord | null;
        switch (this.mode) {
          case "replay":
            record = this.findRecord(
              req.method,
              requestPath,
              req.headers,
              requestBody
            );
            if (record) {
              this.removeRecordFromTape(record);
              console.log(`Replayed: ${req.method} ${requestPath}`);
            } else {
              console.warn(
                chalk.yellow(
                  `Unexpected request ${
                    req.method
                  } ${requestPath} has no matching record in tapes.`
                )
              );
            }
            break;
          case "record":
            record = await this.proxy(
              req.method,
              requestPath,
              req.headers,
              requestBody
            );
            this.addRecordToTape(record);
            console.log(`Recorded: ${req.method} ${requestPath}`);
            break;
          default:
            throw new Error(`Unsupported mode: ${this.mode}`);
        }

        if (record) {
          this.sendResponse(record, res);
        } else {
          res.statusCode = 500;
          res.end();
        }
      } catch (e) {
        console.error(chalk.red("Unexpected error:"), e);
      }
    });
  }

  /**
   * Starts the server.
   */
  async start(port: number) {
    await new Promise(resolve => this.server.listen(port, resolve));
  }

  /**
   * Handles requests that are intended for Proxay itself.
   */
  private handleProxayApi(
    requestPath: string,
    requestBody: RequestBody,
    res: http.ServerResponse
  ) {
    // Sending a request to /__proxay/tape will pick a specific tape.
    if (requestPath === "/__proxay/tape") {
      const json = requestBody.map(chunk => chunk.toString()).join("");
      let tape;
      try {
        tape = JSON.parse(json).tape;
      } catch {
        tape = null;
      }
      if (tape) {
        if (
          path
            .relative(this.tapeDir, path.join(this.tapeDir, tape))
            .startsWith("../")
        ) {
          const errorMessage = `Invalid tape name: ${tape}`;
          console.error(chalk.red(errorMessage));
          res.statusCode = 403;
          res.end(errorMessage);
          return;
        }
        this.loadTape(tape);
        res.end(`Updated tape: ${tape}`);
      } else {
        this.unloadTape();
        res.end(`Unloaded tape`);
      }
    }
  }

  /**
   * Loads a specific tape into memory (erasing it in record mode).
   */
  private loadTape(tapeName: string) {
    this.currentTape = tapeName;
    console.log(chalk.blueBright(`Loaded tape: ${tapeName}`));
    if (this.mode === "record") {
      this.currentTapeRecords = [];
      this.saveTapeToDisk();
    } else {
      this.currentTapeRecords = this.loadTapeFromDisk();
    }
  }

  /**
   * Unloads the current tape, falling back to the default.
   */
  private unloadTape() {
    this.loadTape(DEFAULT_TAPE);
  }

  /**
   * Removes a specific record from the current tape, to make sure that
   * subsequent requests don't replay the same record.
   */
  private removeRecordFromTape(record: TapeRecord) {
    const index = this.currentTapeRecords.findIndex(r => r === record);
    this.currentTapeRecords.splice(index, 1);
  }

  /**
   * Adds a new record to the current tape and saves to disk.
   */
  private addRecordToTape(record: TapeRecord) {
    this.currentTapeRecords.push(record);
    this.saveTapeToDisk();
  }

  /**
   * Saves the tape to disk.
   */
  private saveTapeToDisk() {
    const tapePath = this.getTapePath(this.currentTape);
    fs.ensureDirSync(path.dirname(this.currentTape));
    fs.writeFileSync(
      tapePath,
      yaml.safeDump({
        http_interactions: this.currentTapeRecords
      }),
      "utf8"
    );
  }

  /**
   * Loads the tape from disk.
   */
  private loadTapeFromDisk(): TapeRecord[] {
    const tapePath = this.getTapePath(this.currentTape);
    if (!fs.existsSync(tapePath)) {
      console.warn(chalk.yellow(`No tape found with name ${this.currentTape}`));
      return [];
    }
    return yaml.safeLoad(fs.readFileSync(tapePath, "utf8")).http_interactions;
  }

  /**
   * Returns the tape's path on disk.
   */
  private getTapePath(tapeName: string) {
    return path.join(this.tapeDir, `${tapeName}.yml`);
  }

  /**
   * Finds a matching record for a particular request.
   */
  private findRecord(
    requestMethod: string,
    requestPath: string,
    _requestHeaders: Headers,
    _requestBody: RequestBody
  ): TapeRecord | null {
    for (let i = 0; i < this.currentTapeRecords.length; i += 1) {
      const record = this.currentTapeRecords[i];
      if (
        record.request.method === requestMethod &&
        record.request.path === requestPath
      ) {
        return record;
      }
    }
    return null;
  }

  /**
   * Proxies a specific request and returns the resulting record.
   */
  async proxy(
    requestMethod: string,
    requestPath: string,
    requestHeaders: Headers,
    requestBody: RequestBody
  ): Promise<TapeRecord> {
    if (!this.proxiedHost) {
      throw new Error("Missing proxied host");
    }
    const [scheme, hostname] = this.proxiedHost.split("://");
    try {
      const response = await new Promise<http.IncomingMessage>(resolve => {
        const requestOptions = {
          hostname: hostname,
          method: requestMethod,
          path: requestPath,
          headers: {
            ...requestHeaders,
            host: hostname
          }
        };
        const proxyRequest =
          scheme === "http"
            ? http.request(requestOptions, resolve)
            : https.request(requestOptions, resolve);
        requestBody.forEach(chunk => proxyRequest.write(chunk));
        proxyRequest.end();
      });

      const statusCode = response.statusCode || 200;
      let responseBody = "";
      response.on("data", chunk => {
        responseBody += chunk.toString();
      });
      return new Promise<TapeRecord>(resolve => {
        response.on("end", () => {
          resolve({
            request: {
              method: requestMethod,
              path: requestPath,
              body: requestBody.map(chunk => chunk.toString()).join(""),
              headers: requestHeaders
            },
            response: {
              status: {
                code: statusCode
              },
              headers: response.headers,
              body: responseBody
            }
          });
        });
      });
    } catch (e) {
      if (e.code) {
        console.error(
          chalk.red(
            `Could not proxy request ${requestMethod} ${requestPath} (${
              e.code
            })`
          )
        );
      } else {
        console.error(
          chalk.red(
            `Could not proxy request ${requestMethod} ${requestPath}`,
            e
          )
        );
      }
      throw e;
    }
  }

  /**
   * Sends a particular response to the client.
   */
  private sendResponse(record: TapeRecord, res: http.ServerResponse) {
    res.statusCode = record.response.status.code;
    Object.keys(record.response.headers).forEach(headerName => {
      const headerValue = record.response.headers[headerName];
      if (headerValue) {
        res.setHeader(headerName, headerValue);
      }
    });
    res.end(record.response.body);
  }
}

function receiveRequestBody(req: http.ServerRequest): Promise<RequestBody> {
  const requestChunks: RequestBody = [];
  req.on("data", chunk => {
    requestChunks.push(chunk);
  });
  return new Promise(resolve => {
    req.on("end", () => resolve(requestChunks));
  });
}

function extractPath(url: string) {
  const schemePosition = url.indexOf("://");
  if (schemePosition !== -1) {
    const pathPosition = url.indexOf("/", schemePosition + 3);
    return url.substr(pathPosition);
  } else {
    return url;
  }
}

/**
 * A record of a specific HTTP interaction (request + response).
 */
export type TapeRecord = {
  request: {
    method: string;
    path: string;
    body: string;
    headers: Headers;
  };
  response: {
    status: {
      code: number;
    };
    headers: Headers;
    body: string;
  };
};

const DEFAULT_TAPE = "default";

/**
 * Headers of a request or response.
 */
export type Headers = {
  [headerName: string]: string | string[] | undefined;
};

/**
 * A request body going through Node.
 */
export type RequestBody = Array<string | Buffer>;

/**
 * Possible modes.
 */
export type Mode = ReplayMode | RecordMode;

/**
 * Replays requests from tapes. Fails any unexpected requests.
 */
export type ReplayMode = "replay";

/**
 * Records requests. Ignores recorded tapes.
 */
export type RecordMode = "record";
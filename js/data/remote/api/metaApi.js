import { httpRequest } from "../../../core/network/httpClient.js";

export const MetaApi = {

  async getMeta(url, signal) {
    const opts = { includeSessionAuth: false };
    if (signal) opts.signal = signal;
    return httpRequest(url, opts);
  }

};

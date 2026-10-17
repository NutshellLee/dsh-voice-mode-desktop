// 通过 HTTP 代理建立 wss 连接的最小实现。
//
// 背景：Node 的 ws 不认系统代理，永远直连。微软的朗读接口对来源 IP 敏感，
// 直连某些网络（例如国内家宽）会被直接回 403；走代理出去就是通的。
// 这个 agent 先向代理发 CONNECT 打隧道，再在隧道上做 TLS，交给 ws 使用。
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export class ProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    const host = options.host;
    const port = Number(options.port) || 443;
    const req = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
      method: "CONNECT",
      path: host + ":" + port,
      headers: { Host: host + ":" + port },
      agent: false
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error("proxy CONNECT " + res.statusCode));
        return;
      }
      const tunnel = tls.connect({ socket, servername: host }, () => callback(null, tunnel));
      tunnel.on("error", callback);
    });
    req.on("error", callback);
    req.end();
  }
}

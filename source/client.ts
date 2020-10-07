import * as libcrypto from "crypto";
import * as libhttp from "http";
import * as libhttps from "https";
import * as libnet from "net";
import * as liburl from "url";
import * as stdlib from "@joelek/ts-stdlib";
import * as frames from "./frames";
import * as is from "./is";
import { getHeader } from "./shared";

function makeHttpPromise(url: string, options: libhttp.RequestOptions): Promise<libhttp.IncomingMessage> {
	return new Promise((resolve, reject) => {
		libhttp.get(url, options)
			.on("upgrade", resolve)
			.on("error", reject);
	});
}

function makeHttpsPromise(url: string, options: libhttps.RequestOptions): Promise<libhttp.IncomingMessage> {
	return new Promise((resolve, reject) => {
		libhttps.get(url, options)
			.on("upgrade", resolve)
			.on("error", reject);
	});
}

export enum ReadyState {
	CONNECTING,
	OPEN,
	CLOSING,
	CLOSED
};

export class WebSocketClient {
	private state: ReadyState;
	private listeners: stdlib.routing.MessageRouter<WebSocketEventMap>;
	private pending: Array<Buffer>;
	private socket: libnet.Socket | undefined;

	private onFrame(socket: libnet.Socket, frame: frames.WebSocketFrame): any {
		if (frame.reserved1 !== 0 || frame.reserved2 !== 0 || frame.reserved3 !== 0) {
			return socket.emit("error");
		}
		if (frame.opcode < 8) {
			if (frame.opcode === frames.WebSocketFrameType.CONTINUATION || frame.opcode === frames.WebSocketFrameType.TEXT || frame.opcode == frames.WebSocketFrameType.BINARY) {
				if (this.pending.length === 0) {
					if (frame.opcode === frames.WebSocketFrameType.CONTINUATION) {
						return socket.emit("error");
					}
				} else  {
					if (frame.opcode !== frames.WebSocketFrameType.CONTINUATION) {
						return socket.emit("error");
					}
				}
				this.pending.push(frame.payload);
				if (frame.final === 1) {
					let buffer = Buffer.concat(this.pending);
					this.pending.splice(0);
					this.listeners.route("message", {
						data: buffer.toString()
					} as any);
				}
			} else {
				return socket.emit("error");
			}
		} else {
			if (frame.final !== 1) {
				return socket.emit("error");
			}
			if (frame.payload.length > 125) {
				return socket.emit("error");
			}
			if (frame.opcode === frames.WebSocketFrameType.CLOSE) {
				socket.write(frames.encodeFrame({
					...frame,
					masked: 0
				}), () => {
					return socket.end();
				});
			} else if (frame.opcode === frames.WebSocketFrameType.PING) {
				socket.write(frames.encodeFrame({
					...frame,
					opcode: 0x0A,
					masked: 0
				}));
			} else if (frame.opcode === frames.WebSocketFrameType.PONG) {
			} else {
				return socket.emit("error");
			}
		}
	}

	constructor(url: string) {
		this.state = ReadyState.CONNECTING;
		this.listeners = new stdlib.routing.MessageRouter<WebSocketEventMap>();
		this.pending = new Array<Buffer>();
		this.socket = undefined;
		let key = libcrypto.randomBytes(16).toString("base64");
		let headers: libhttp.OutgoingHttpHeaders = {
			"Connection": "upgrade",
			"Host": liburl.parse(url).host ?? "",
			"Sec-WebSocket-Key": key,
			"Sec-WebSocket-Version": "13",
			"Upgrade": "websocket"
		};
		(() => {
			if (url.startsWith("wss:")) {
				return makeHttpsPromise("https:" + url.substring(4), { headers, rejectUnauthorized: false });
			} else if (url.startsWith("ws:")) {
				return makeHttpPromise("http:" + url.substring(3), { headers });
			} else {
				throw `Expected ${url} to be a WebSocket URL!`;
			}
		})().then((response) => {
			let socket = response.socket;
			socket.on("close", () => {
				this.state = ReadyState.CLOSED;
				this.listeners.route("close", undefined as any);
			});
			socket.on("error", () => {
				this.state = ReadyState.CLOSING;
				this.listeners.route("error", undefined as any);
				socket.end();
			});
			if (response.statusCode !== 101) {
				return socket.emit("error");
			}
			if (getHeader(response, "Connection")?.toLowerCase() !== "upgrade") {
				return socket.emit("error");
			}
			if (getHeader(response, "Upgrade")?.toLowerCase() !== "websocket") {
				return socket.emit("error");
			}
			let accept = libcrypto.createHash("sha1")
				.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
				.digest("base64");
			if (getHeader(response, "Sec-WebSocket-Accept") !== accept) {
				return socket.emit("error");
			}
			this.socket = socket;
			this.state = ReadyState.OPEN;
			this.socket.on("data", (buffer) => {
				let state = {
					buffer,
					offset: 0
				};
				try {
					while (state.offset < buffer.length) {
						let frame = frames.decodeFrame(state);
						this.onFrame(socket, frame);
					}
				} catch (error) {
					return socket.emit("error");
				}
			});
			this.listeners.route("open", undefined as any);
		});
	}

	addEventListener<A extends keyof WebSocketEventMap>(type: A, listener: (event: WebSocketEventMap[A]) => void): void {
		this.listeners.addObserver(type, listener);
	}

	removeEventListener<A extends keyof WebSocketEventMap>(type: A, listener: (event: WebSocketEventMap[A]) => void): void {
		this.listeners.removeObserver(type, listener);
	}

	send(payload: string | Buffer): void {
		if (this.state !== ReadyState.OPEN) {
			throw `Expected socket to be open!`;
		}
		let socket = this.socket;
		if (is.absent(socket)) {
			throw `Expected socket to be open!`;
		}
		let final = 1;
		let reserved1 = 0;
		let reserved2 = 0;
		let reserved3 = 0;
		let opcode = frames.WebSocketFrameType.BINARY;
		let masked = 1;
		if (!(payload instanceof Buffer)) {
			payload = Buffer.from(payload, "utf8");
			opcode = frames.WebSocketFrameType.TEXT;
		}
		let frame = frames.encodeFrame({
			final,
			reserved1,
			reserved2,
			reserved3,
			opcode,
			masked,
			payload
		});
		socket.write(frame);
	}

	get readyState(): ReadyState {
		return this.state;
	}
};
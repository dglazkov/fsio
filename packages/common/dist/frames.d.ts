export declare const HEADER_SIZE = 5;
export declare const FrameType: {
    readonly DATA: 1;
    readonly RPC: 5;
};
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];
export interface Frame {
    /** Frame type byte; unknown values are possible from newer peers. */
    type: number;
    payload: Uint8Array;
}
export declare function frameTypeName(type: number): string;
export declare function encodeFrame(type: number, payload: Uint8Array): Uint8Array;
export declare function jsonFrame(type: number, obj: unknown): Uint8Array;
export declare function decodeJson<T = unknown>(payload: Uint8Array): T;
/** Parse as many complete frames as possible from `bytes`.
 *  `consumed` stops before any trailing partial frame. */
export declare function parseFrames(bytes: Uint8Array): {
    frames: Frame[];
    consumed: number;
};
export declare function concatBytes(arrays: Uint8Array[]): Uint8Array;
/** Cross-process comparable timestamp in ms (epoch-based, sub-ms precision). */
export declare function now(): number;
export declare function chunkName(seq: number): string;
export declare const CHUNK_RE: RegExp;
export declare const DIR_CHUNK_RE: RegExp;
export declare function dirChunkName(seq: number, bytes: Uint8Array): string;
export declare function b64urlEncode(bytes: Uint8Array): string;
export declare function b64urlDecode(str: string): Uint8Array;
export declare const DIR_CHUNK_MAX_BYTES = 180;
//# sourceMappingURL=frames.d.ts.map
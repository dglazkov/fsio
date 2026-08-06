/** Bumped when a field's meaning changes. A host and a page from different
 *  builds meet in a folder more often than you would think — the shell ships
 *  on our schedule and `pewt` is installed on yours. */
export declare const CONTROL_VERSION = 1;
/** Host → page, on the session's downlink: answer this. */
export interface Command {
    v: number;
    type: "pewt:command";
    /** what the receipt comes back against. The host mints it; the page only
     *  ever echoes it. */
    id: string;
    method: string;
    params: unknown;
}
/** Page → host, on the same session's uplink. One per command, ever. */
export type Receipt = {
    v: number;
    type: "pewt:receipt";
    id: string;
    ok: true;
    result: Record<string, unknown>;
} | {
    v: number;
    type: "pewt:receipt";
    id: string;
    ok: false;
    error: {
        code: string;
        message: string;
        hint?: string;
    };
};
export declare const command: (id: string, method: string, params: unknown) => Command;
export declare const receipt: (id: string, result: Record<string, unknown>) => Receipt;
export declare const receiptError: (id: string, error: {
    code: string;
    message: string;
    hint?: string;
}) => Receipt;
export declare const encodeControl: (msg: Command | Receipt) => string;
export declare const asCommand: (bytes: Uint8Array | string) => Command | null;
export declare const asReceipt: (bytes: Uint8Array | string) => Receipt | null;
//# sourceMappingURL=control.d.ts.map
# @fsio/common

The fsio protocol core: the frame codec, the JSON-RPC control plane, and the
schemas of the files the two halves exchange. Both
[`@fsio/host`](https://github.com/dglazkov/fsio/tree/main/packages/host) and
[`@fsio/client`](https://github.com/dglazkov/fsio/tree/main/packages/client)
depend on it, and npm installs one shared copy.

You do not install this package directly. It arrives with whichever half you
install, and you import from it when you need a protocol type or an error code
by name:

```ts
import { RpcError, RpcErrors, type SessionStatus } from "@fsio/common";

try {
  await session.ready;
} catch (err) {
  if (err instanceof RpcError && err.code === RpcErrors.SPAWN_DENIED) {
    showConsentPrompt(err.message);
  }
}
```

The one thing worth knowing about it: **install one copy, not two.** `RpcError`
is a class and `FrameType` is an enum, so a project that ends up with two
copies gets two distinct identities, and `instanceof` returns `false` with no
other symptom. Both halves declare the same branch as their dependency
precisely so this cannot happen. If you vendor either half by hand, keep them
pointed at one `@fsio/common`.

The file formats these types describe are specified in
[spec/PROTOCOL.md](https://github.com/dglazkov/fsio/blob/main/spec/PROTOCOL.md).

> **Stability: unstable.** The API changes without notice and without a
> deprecation period.

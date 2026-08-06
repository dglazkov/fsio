// An agent, as an extension holds one.
//
// Pewter ships no agent and is not an ACP client. It speaks the Agent Client
// Protocol in the sense that it carries it: an adapter is an ordinary process
// on your machine, its stdio rides the folder, and one message crosses in one
// piece in each direction. **The extension is the client.**
//
// That is not an accident of layering, it is the point. `session/request_
// permission` and `fs/read_text_file` arrive as requests *from* the agent,
// and the party that should answer them is the one with the human and the
// folder — which is the tab, not the host. An API that answered them here
// would be deciding on the tab's behalf what the human would have said.
//
// So what this hands over is messages. Correlating ids, answering requests,
// and drawing whatever a permission question should look like are the
// extension's, and a chat tab is where they belong.
/** Options → the spec that goes on the wire. Trivial, and here rather than
 *  inline so the command line and an extension cannot spell it differently
 *  (the `shell` slice's lesson, for the same reason). */
export function agentSpec(options = {}) {
    return {
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(options.repo !== undefined ? { repo: options.repo } : {}),
    };
}
//# sourceMappingURL=agent.js.map
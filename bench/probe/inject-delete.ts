// Probe edit: the pattern of an old enforcement extension. Each prompt adds a
// context message; the context handler keeps only the newest one, so the
// earlier one is deleted from the history at the next prompt.
export default function (pi: any) {
  pi.on("before_agent_start", () => ({ message: { customType: "probe-context", content: "Probe context: mode BUILD.", display: false } }));
  pi.on("context", (event: any) => {
    const last = event.messages.findLastIndex((m: any) => m.customType === "probe-context");
    const filtered = event.messages.filter((m: any, i: number) => m.customType !== "probe-context" || i === last);
    return filtered.length !== event.messages.length ? { messages: filtered } : undefined;
  });
}

// Probe edit: from the 4th model call on, replace the first long tool result
// with a fixed placeholder, as condensed-milk does at a mask event.
let calls = 0;
export default function (pi: any) {
  pi.on("context", (event: any) => {
    calls++;
    if (calls < 4) return undefined;
    let done = false;
    const messages = event.messages.map((m: any) => {
      if (done || m.role !== "toolResult") return m;
      const text = (m.content ?? []).map((c: any) => c.text ?? "").join("");
      if (text.length < 500) return m;
      done = true;
      return { ...m, content: [{ type: "text", text: "[cm-masked bash #0000probe] (masked by probe)" }] };
    });
    return { messages };
  });
}

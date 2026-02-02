/**
 * Logging utilities for the Wiggum Loop harness.
 *
 * - JSONL per session (tail-able)
 * - Master log with summaries
 * - Pretty-print for terminal output
 * - XML tag extraction for verifier reports
 */

export type RunKind = "builder" | "verifier";

export type RunResult = {
  kind: RunKind;
  logPath: string;
  resultText: string;
  sawBuilderDone: boolean;
  sawVerifierDone: boolean;
  extractedVerifierReport: string | null;
  hadError: boolean;
};

// Completion markers
export const BUILDER_DONE = "===WIGGUM_COMPLETE===";
export const VERIFIER_DONE = "===VERIFIER_COMPLETE===";

// Verifier report XML tags
const REPORT_OPEN = "<verifier-report>";
const REPORT_CLOSE = "</verifier-report>";

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours(),
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function safeJsonStringify(obj: any): string {
  return JSON.stringify(obj, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function extractTextFromAssistantMessage(msg: any): string {
  const content = msg?.message?.content;
  if (!content) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        out += block.text;
      }
    }
    return out;
  }
  return "";
}

export function extractToolUsesFromAssistantMessage(
  msg: any,
): Array<{ name: string; input: any }> {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return [];
  const uses: Array<{ name: string; input: any }> = [];
  for (const block of content) {
    if (block?.type === "tool_use" && typeof block?.name === "string") {
      uses.push({ name: block.name, input: block.input });
    }
  }
  return uses;
}

/**
 * Extract verifier report from XML tags: <verifier-report>...</verifier-report>
 * Falls back to returning the full text if no tags found.
 */
export function extractVerifierReport(text: string): string | null {
  const start = text.indexOf(REPORT_OPEN);
  const end = text.indexOf(REPORT_CLOSE);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start + REPORT_OPEN.length, end).trim();
}

export function prettyPrintMessage(kind: RunKind, msg: any): void {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log(
      `[${kind}] init: model=${msg.model} permissionMode=${msg.permissionMode} cwd=${msg.cwd}`,
    );
    return;
  }

  if (msg.type === "assistant") {
    const toolUses = extractToolUsesFromAssistantMessage(msg);
    for (const tu of toolUses) {
      const hint =
        tu?.name === "Bash" && tu?.input?.command
          ? `: ${String(tu.input.command).slice(0, 180)}`
          : "";
      console.log(`[${kind}] tool -> ${tu.name}${hint}`);
    }

    const text = extractTextFromAssistantMessage(msg);
    if (text.trim()) {
      process.stdout.write(text);
      if (!text.endsWith("\n")) process.stdout.write("\n");
    }
    return;
  }

  if (msg.type === "result") {
    console.log(
      `[${kind}] done: ${msg.subtype} turns=${msg.num_turns} error=${msg.is_error}`,
    );
  }
}

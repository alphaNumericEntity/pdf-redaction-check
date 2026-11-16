#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { checkRedaction, type RedactionReport, type Verdict } from "./check.js";
import { formatReport } from "./format.js";

const USAGE = `Usage: pdf-redaction-check [options] <file.pdf>...

Checks whether redacted content in a PDF can still be recovered: text left
under black boxes, Redact annotations that were never applied, earlier saved
versions inside the file, and terms you name.

Options:
  -t, --term <text>      Also fail if this text can be found (repeatable)
      --fail-on <level>  Exit 1 at "leak" (default) or at "warn"
      --json             Print the full reports as JSON
  -q, --quiet            Print nothing; use the exit code
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes: 0 = passed, 1 = a file reached the --fail-on level, 2 = error.`;

const RANK: Record<Verdict, number> = { clean: 0, warn: 1, leak: 2 };

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        term: { type: "string", short: "t", multiple: true },
        "fail-on": { type: "string", default: "leak" },
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", short: "q", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  const failOn = values["fail-on"];
  if (failOn !== "leak" && failOn !== "warn") {
    console.error(`--fail-on must be "leak" or "warn", got "${failOn}"`);
    return 2;
  }
  if (positionals.length === 0) {
    console.error(USAGE);
    return 2;
  }

  const results: { file: string; report?: RedactionReport; error?: string }[] = [];
  for (const file of positionals) {
    try {
      const bytes = new Uint8Array(await readFile(file));
      results.push({ file, report: await checkRedaction(bytes, { terms: values.term ?? [] }) });
    } catch (error) {
      results.push({ file, error: (error as Error).message });
    }
  }

  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
  } else if (!values.quiet) {
    for (const r of results) {
      console.log(r.report ? formatReport(r.report, r.file) : `${r.file}: ERROR: ${r.error}`);
    }
  }
  if (results.some((r) => r.error)) return 2;
  return results.some((r) => RANK[r.report!.verdict] >= RANK[failOn]) ? 1 : 0;
}

process.exitCode = await main();

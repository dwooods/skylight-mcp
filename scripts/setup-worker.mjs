#!/usr/bin/env node
// One-command setup for your own hosted Worker (Claude Duet / remote MCP).
//   npm run worker:setup            do it
//   npm run worker:setup -- --dry-run   show the steps, change nothing
//
// It creates your KV namespace, writes the gitignored wrangler.local.jsonc,
// sets your passphrase and WORKER_URL as Worker secrets, deploys, and prints
// the connector URL. Nothing account-specific is written to a tracked file.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseKvId, parseWorkerUrl, passphraseProblem, patchKvId } from "./setup-worker-lib.mjs";

const dry = process.argv.includes("--dry-run");
const LOCAL = "wrangler.local.jsonc";
const say = (s) => console.log(s);

function wrangler(args, input) {
  if (dry) {
    say(`  [dry run] npx wrangler ${args.join(" ")}`);
    return { status: 0, out: "" };
  }
  const r = spawnSync("npx", ["wrangler", ...args], { input, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) {
    say(out);
    throw new Error(`wrangler ${args[0]} failed`);
  }
  return { status: 0, out };
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput;
    process.stdout.write(question);
    rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl._writeToOutput = write;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  say("Skylight MCP: hosted Worker setup\n");

  say("1. Checking you are logged in to Cloudflare");
  if (!dry) {
    const who = spawnSync("npx", ["wrangler", "whoami"], { encoding: "utf8" });
    if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
      throw new Error("Not logged in to Cloudflare. Run `npx wrangler login`, then run this again.");
    }
  }

  say("2. Creating your local config (gitignored)");
  if (existsSync(LOCAL)) {
    say(`   ${LOCAL} already exists; reusing it.`);
  } else if (!dry) {
    copyFileSync("wrangler.jsonc", LOCAL);
  }

  say("3. Creating the KV namespace for sign-in state");
  const current = !dry && existsSync(LOCAL) ? readFileSync(LOCAL, "utf8") : "";
  if (dry || current.includes("REPLACE_WITH_KV_NAMESPACE_ID")) {
    const { out } = wrangler(["kv", "namespace", "create", "OAUTH_KV"]);
    if (!dry) {
      const id = parseKvId(out);
      if (!id) throw new Error("Could not read the namespace id from wrangler's output. Create it by hand and paste the id into " + LOCAL);
      writeFileSync(LOCAL, patchKvId(current, id));
      say("   Wrote the namespace id into " + LOCAL);
    }
  } else {
    say("   A namespace id is already set in " + LOCAL + "; keeping it.");
  }

  say("4. Setting your sign-in passphrase (12+ characters; you type it on the consent page)");
  if (dry) {
    wrangler(["secret", "put", "SETUP_PASSPHRASE", "-c", LOCAL]);
  } else {
    let pass = "";
    for (;;) {
      pass = await askHidden("   Choose a passphrase: ");
      const problem = passphraseProblem(pass);
      if (!problem) break;
      say("   " + problem);
    }
    wrangler(["secret", "put", "SETUP_PASSPHRASE", "-c", LOCAL], pass + "\n");
  }

  say("5. First deploy (to learn your Worker's URL)");
  const first = wrangler(["deploy", "-c", LOCAL]);
  const url = dry ? "https://skylight-mcp.<your-subdomain>.workers.dev" : parseWorkerUrl(first.out);
  if (!url) throw new Error("Could not read the Worker URL from the deploy output. Set WORKER_URL by hand, see the README.");

  say("6. Binding the Worker to its own URL, then deploying again");
  wrangler(["secret", "put", "WORKER_URL", "-c", LOCAL], url + "\n");
  wrangler(["deploy", "-c", LOCAL]);

  say("\nDone. Add this as a custom connector in Claude:\n");
  say(`   ${url}/mcp\n`);
  say("On the consent screen enter your passphrase, then sign in to Skylight.");
  say("Keep the URL and wrangler.local.jsonc to yourself; both are specific to your account.");
}

main().catch((e) => {
  console.error("\n" + e.message);
  process.exit(1);
});

"use strict";
/**
 * Update checker — one registry request per run, bounded by a 5s timeout.
 * If the registry has a newer semver, print an upgrade banner.
 *
 * Seams (all optional, default to the real fs/https/process.env):
 *   fetchFn    — wraps https.get; returns the response body or null.
 *   env        — gates: OMPP_NO_UPDATE_CHECK, CI.
 *   fsAdapter  — existsSync, for the dev-checkout .git skip.
 *   rootDir    — package root the .git skip and package.json resolve from.
 *   version    — current version; defaults to package.json.
 *   out        — banner stream; defaults to console.error.
 */

const fs = require("fs");

const path = require("path");

const https = require("https");

const REGISTRY_URL = "https://registry.npmjs.org/@nevermorelove%2fompp";

const FETCH_TIMEOUT_MS = 5000;

// --- fetch seam --------------------------------------------------------------
// The https.get wrapper. Resolves the response body, or null on non-200,
// timeout (5s), or transport error. Parse happens in fetchLatestVersion so
// tests can stub the network with a plain async function.
function fetchRegistryBody(url = REGISTRY_URL) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();

          return resolve(null);
        }

        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

async function fetchLatestVersion(opts = {}) {
  const { fetchFn = fetchRegistryBody } = opts;
  let body = null;

  try {
    body = await fetchFn(REGISTRY_URL);
  } catch {
    return null;
  }

  if (body == null) return null;

  try {
    return JSON.parse(body)["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  }
}

// --- semver compare ---------------------------------------------------------
// Loose: split on dots/dashes, take the first 3 tokens (prerelease
// suffixes beyond the 3rd part are ignored, e.g. "0.4.2-rc.1" == "0.4.2"),
// NaN -> 0. Good enough for "0.4.2" vs "0.4.3".
function isNewerVersion(current, latest) {
  const parse = (v) =>
    v.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);

  const [cmaj, cmin, cpat] = parse(current);
  const [lmaj, lmin, lpat] = parse(latest);

  if (lmaj !== cmaj) return lmaj > cmaj;

  if (lmin !== cmin) return lmin > cmin;

  return lpat > cpat;
}

// --- banner -----------------------------------------------------------------
function printUpdateBanner(current, latest, out = console.error) {
  const line = `Update available! ${current} -> ${latest}`;
  const hint = `Run "npm i -g @nevermorelove/ompp" to update`;
  const inner = Math.max(line.length, hint.length) + 2;
  const pad = (s) => " " + s + " ".repeat(inner - 1 - s.length);
  out("┌" + "─".repeat(inner) + "┐");
  out("│" + pad(line) + "│");
  out("│" + pad(hint) + "│");
  out("└" + "─".repeat(inner) + "┘");
}

// --- orchestration ----------------------------------------------------------
// Returns {current, latest} when an update is available (banner printed),
// null otherwise. Every gate returns null — never undefined — so callers
// can distinguish "checked, nothing to do" from "checked, update found".
async function checkForUpdate(opts = {}) {
  const {
    env = process.env,
    fsAdapter = fs,
    rootDir = path.join(__dirname, ".."),
    version,
    fetchFn,
    out,
  } = opts;

  if (env.OMPP_NO_UPDATE_CHECK === "1") return null;

  if (env.CI) return null;

  // Skip dev checkouts: a repo clone updates via git, not npm.
  if (fsAdapter.existsSync(path.join(rootDir, ".git"))) return null;

  const current = version ?? require("../package.json").version;
  const latest = await fetchLatestVersion({ fetchFn });

  if (latest && isNewerVersion(current, latest)) {
    printUpdateBanner(current, latest, out);

    return { current, latest };
  }

  return null;
}

module.exports = {
  isNewerVersion,
  fetchLatestVersion,
  printUpdateBanner,
  checkForUpdate,
};

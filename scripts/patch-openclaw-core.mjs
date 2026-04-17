#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..");

function resolveExecutablePath(name) {
  const pathEnv = process.env.PATH || "";
  const candidates = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of candidates) {
    const fullPath = path.join(dir, name);
    try {
      if (fs.statSync(fullPath).isFile()) return fullPath;
    } catch {
      continue;
    }
  }
  return null;
}

function findDistRoots() {
  const roots = new Set();
  const openclawBin = resolveExecutablePath("openclaw");
  if (openclawBin) {
    try {
      const resolved = fs.realpathSync(openclawBin);
      const resolvedDir = path.dirname(resolved);
      const fromResolved = path.join(resolvedDir, "dist");
      if (fs.existsSync(fromResolved)) roots.add(fromResolved);
      const fromParent = path.join(resolvedDir, "..", "dist");
      if (fs.existsSync(fromParent)) roots.add(path.resolve(fromParent));
    } catch {
      // best effort
    }
  }
  const fromLocalDep = path.join(workspaceRoot, "node_modules", "openclaw", "dist");
  if (fs.existsSync(fromLocalDep)) roots.add(fromLocalDep);
  return Array.from(roots);
}

function collectJsFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
      continue;
    }
    if (entry.isFile() && full.endsWith(".js")) out.push(full);
  }
  return out;
}

function patchTelegramCommandBlock(source) {
  const blockPattern =
    /(^[ \t]*)(const|let) match = matchPluginCommand\(commandBody\);\n(\1if \(!match\) \{\n[\s\S]*?\n\1\})/gm;
  let replacements = 0;
  const patched = source.replace(blockPattern, (full, indent, _decl, missingBlock) => {
    if (!missingBlock.includes("withTelegramApiErrorLogging")) return full;
    if (!missingBlock.includes('bot.api.sendMessage(chatId, "Command not found.")')) return full;
    if (full.includes("loadOpenClawPlugins({")) return full;
    replacements += 1;
    return (
      `${indent}let match = matchPluginCommand(commandBody);\n` +
      `${indent}if (!match) {\n` +
      `${indent}\ttry {\n` +
      `${indent}\t\tloadOpenClawPlugins({\n` +
      `${indent}\t\t\tconfig: cfg,\n` +
      `${indent}\t\t\tworkspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg))\n` +
      `${indent}\t\t});\n` +
      `${indent}\t} catch (err) {\n` +
      `${indent}\t\tlogVerbose(\`telegram plugin command reload failed: \${String(err)}\`);\n` +
      `${indent}\t}\n` +
      `${indent}\tmatch = matchPluginCommand(commandBody);\n` +
      `${indent}}\n` +
      `${missingBlock}`
    );
  });
  return { patched, replacements };
}

function patchPluginCommandSessionContext(source) {
  let replacements = 0;
  let patched = source;

  const pluginInvocationPattern =
    /(from:\s*command\.from,\n([ \t]*)to:\s*command\.to,\n\2accountId:\s*params\.ctx\.AccountId \?\? void 0,\n\2messageThreadId:\s*typeof params\.ctx\.MessageThreadId === "number" \? params\.ctx\.MessageThreadId : void 0)(?!,\n\2sessionKey:)/gm;
  patched = patched.replace(pluginInvocationPattern, (full, block, indent) => {
    replacements += 1;
    return (
      `${block},\n` +
      `${indent}sessionKey: params.sessionKey ?? (typeof params.ctx.SessionKey === "string" ? params.ctx.SessionKey : void 0),\n` +
      `${indent}sessionId: params.sessionId ?? (typeof params.ctx.SessionId === "string" ? params.ctx.SessionId : void 0)`
    );
  });

  const pluginInvocationPriorityPattern =
    /(sessionKey:\s*)typeof params\.ctx\.SessionKey === "string" \? params\.ctx\.SessionKey : params\.sessionKey,\n([ \t]*)sessionId:\s*typeof params\.ctx\.SessionId === "string" \? params\.ctx\.SessionId : void 0/gm;
  patched = patched.replace(pluginInvocationPriorityPattern, (full, keyPrefix, indent) => {
    replacements += 1;
    return (
      `${keyPrefix}params.sessionKey ?? (typeof params.ctx.SessionKey === "string" ? params.ctx.SessionKey : void 0),\n` +
      `${indent}sessionId: params.sessionId ?? (typeof params.ctx.SessionId === "string" ? params.ctx.SessionId : void 0)`
    );
  });

  const pluginCtxPattern =
    /(commandBody,\n([ \t]*)config,\n\2from:\s*params\.from,\n\2to:\s*params\.to,\n\2accountId:\s*params\.accountId,\n\2messageThreadId:\s*params\.messageThreadId)(?!,\n\2sessionKey:)/gm;
  patched = patched.replace(pluginCtxPattern, (full, block, indent) => {
    replacements += 1;
    return `${block},\n${indent}sessionKey: params.sessionKey,\n${indent}sessionId: params.sessionId`;
  });

  return { patched, replacements };
}

function patchOpenAITextVerbosityDefault(source) {
  let replacements = 0;
  const patched = source.replace(
    /merged\.text_verbosity\s*=\s*"low";/g,
    () => {
      replacements += 1;
      return 'merged.text_verbosity = "medium";';
    },
  );
  return { patched, replacements };
}

function patchDistRoot(distRoot) {
  const jsFiles = collectJsFiles(distRoot);
  let patchedFiles = 0;
  let patchedBlocks = 0;
  for (const file of jsFiles) {
    const raw = fs.readFileSync(file, "utf8");
    let patched = raw;
    let replacements = 0;

    if (raw.includes("matchPluginCommand(commandBody)") && raw.includes('bot.api.sendMessage(chatId, "Command not found.")')) {
      const telegramPatch = patchTelegramCommandBlock(patched);
      patched = telegramPatch.patched;
      replacements += telegramPatch.replacements;
    }

    if (raw.includes("executePluginCommand({") || raw.includes("messageThreadId: params.messageThreadId")) {
      const pluginSessionPatch = patchPluginCommandSessionContext(patched);
      patched = pluginSessionPatch.patched;
      replacements += pluginSessionPatch.replacements;
    }

    if (raw.includes("applyDefaultOpenAIGptRuntimeParams") && raw.includes('merged.text_verbosity = "low";')) {
      const textVerbosityPatch = patchOpenAITextVerbosityDefault(patched);
      patched = textVerbosityPatch.patched;
      replacements += textVerbosityPatch.replacements;
    }

    if (replacements <= 0) continue;
    fs.writeFileSync(file, patched, "utf8");
    patchedFiles += 1;
    patchedBlocks += replacements;
    console.log(`[patch-openclaw-core] patched ${path.relative(distRoot, file)} (${replacements} block)`);
  }
  return { patchedFiles, patchedBlocks };
}

function main() {
  const distRoots = findDistRoots();
  if (distRoots.length === 0) {
    console.log("[patch-openclaw-core] no OpenClaw dist directory found; skipping.");
    return;
  }
  let totalFiles = 0;
  let totalBlocks = 0;
  for (const root of distRoots) {
    const { patchedFiles, patchedBlocks } = patchDistRoot(root);
    totalFiles += patchedFiles;
    totalBlocks += patchedBlocks;
  }
  if (totalFiles === 0) {
    console.log("[patch-openclaw-core] no patch changes needed (already patched or no matching bundle).");
    return;
  }
  console.log(`[patch-openclaw-core] applied ${totalBlocks} patch block(s) across ${totalFiles} file(s).`);
}

main();

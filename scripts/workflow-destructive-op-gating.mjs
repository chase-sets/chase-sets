import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseDocument } from "yaml";

export const DESTRUCTIVE_GRAMMAR = JSON.parse(
  readFileSync(new URL("./workflow-destructive-op-gating-grammar.json", import.meta.url), "utf8"),
);

function sourceText(grammar, id) {
  const source = grammar.sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`Missing authoritative source ${id}.`);
  return source.lines.join("\n");
}

function closing(source, start, open = "(", close = ")") {
  let depth = 1;
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === "`") quote = character;
    else if (source.startsWith("/*", index)) index = source.indexOf("*/", index + 2) + 1;
    else if (source.startsWith("//", index)) index = source.indexOf("\n", index + 2);
    else if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index;
  }
  return source.length;
}

function registrations(source, name) {
  const result = [];
  for (const match of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
    const start = match.index + match[0].length - 1;
    result.push(source.slice(start + 1, closing(source, start)));
  }
  return result;
}

function quoted(source) {
  return [...source.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
}

function bashProductions(source) {
  let grammar = "";
  for (let index = source.indexOf("%%") + 2; index < source.length; index += 1) {
    if (source.startsWith("%%", index)) break;
    if (source.startsWith("/*", index)) index = source.indexOf("*/", index + 2) + 1;
    else if (source[index] === "{") index = closing(source, index, "{", "}");
    else if (source[index] === "'") {
      const match = source.slice(index).match(/^'(?:\\.|[^'\\])*'/);
      if (match) {
        grammar += match[0];
        index += match[0].length - 1;
      }
    } else grammar += source[index];
  }
  const tokens = grammar.match(/'(?:\\.|[^'\\])*'|\w+|[:|;]/g) ?? [];
  const productions = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index + 1] !== ":") continue;
    const production = tokens[index];
    let rhs = [];
    index += 2;
    for (; index < tokens.length; index += 1) {
      if (tokens[index] === "|" || tokens[index] === ";") {
        productions.push({ production, rhs: rhs.join(" ") });
        rhs = [];
        if (tokens[index] === ";") break;
      } else rhs.push(tokens[index]);
    }
  }
  return productions;
}

const supportedShellProductions = new Set([
  "simple_command_element",
  "simple_command",
  "redirection",
  "redirection_list",
  "command",
  "shell_command",
  "subshell",
  "group_command",
  "list0",
  "list1",
  "simple_list",
  "simple_list1",
  "pipeline",
  "pipeline_command",
  "compound_list",
  "newline_list",
  "list_terminator",
  "case_command",
  "case_clause",
  "case_clause_sequence",
  "pattern",
  "if_command",
  "for_command",
  "while_command",
  "until_command",
  "function_def",
  "function_body",
]);

export function deriveAuthoritativeGrammar(grammar = DESTRUCTIVE_GRAMMAR) {
  const members = [];
  const add = (id, source, surface, form, disposition = "INDETERMINATE") =>
    members.push({ id, source, surface, form, disposition });
  for (const { production, rhs } of bashProductions(sourceText(grammar, "bash"))) {
    add(
      `bash:${production}:${rhs}`,
      "bash",
      "shell",
      { production, rhs },
      supportedShellProductions.has(production) &&
        !/\b(?:arith_command|arith_for_command|cond_command|select_command|coproc)\b/.test(rhs)
        ? "HANDLED"
        : "INDETERMINATE",
    );
  }
  const constants = new Map(
    [...sourceText(grammar, "doctl-constants").matchAll(/\b(Arg\w+)\s*=\s*"([^"\n]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const global = sourceText(grammar, "doctl-global");
  for (const match of global.matchAll(
    /rootPFlagSet\.(String|Bool|Int)Var(P)?\([^,]+,\s*("[^"]+"|doctl\.\w+)(?:,\s*"([^"]*)")?/g,
  )) {
    const name = match[3].startsWith('"') ? JSON.parse(match[3]) : constants.get(match[3].slice(6));
    add(
      `doctl:option:${name}`,
      "doctl-global",
      "doctl-option",
      {
        names: [`--${name}`, ...(match[2] && match[4] ? [`-${match[4]}`] : [])],
        arity: match[1] === "Bool" ? 0 : 1,
      },
      name ? "HANDLED" : "INDETERMINATE",
    );
  }
  for (const match of global.matchAll(/DoitCmd\.AddCommand\((\w+)\(\)\)/g)) {
    add(`doctl:root:${match[1]}`, "doctl-global", "doctl-root", { registration: match[1] }, "HANDLED");
  }
  const registry = sourceText(grammar, "doctl-registry");
  for (const match of registry.matchAll(/Use:\s*"([^"]+)"[\s\S]*?Aliases:\s*\[\]string\{([^}]+)\}/g)) {
    add(
      `doctl:group:${match[1]}`,
      "doctl-registry",
      "doctl-group",
      { names: [match[1], ...quoted(match[2])] },
      "HANDLED",
    );
  }
  for (const call of registrations(registry, "CmdBuilder")) {
    const handler = call.match(/\bRun\w+/)?.[0];
    const name = quoted(call)[0]?.split(" ")[0];
    if (!handler || !name) continue;
    const group = handler.includes("Repository")
      ? "repository"
      : handler.includes("GarbageCollection")
        ? "garbage-collection"
        : "registry";
    const aliases = registrations(call, "aliasOpt").flatMap(quoted);
    add(
      `doctl:command:${group}:${name}`,
      "doctl-registry",
      "doctl-command",
      { group, names: [name, ...aliases] },
      "HANDLED",
    );
  }
  const terraformGlobal = sourceText(grammar, "terraform-global");
  for (const match of terraformGlobal.matchAll(/const argName = "([^"]+)"/g)) {
    add(
      `terraform:option:${match[1]}`,
      "terraform-global",
      "terraform-option",
      { names: [match[1]], arity: "equals" },
      "HANDLED",
    );
  }
  for (const match of sourceText(grammar, "terraform-commands").matchAll(
    /"([^"]+)":\s*func\(\)\s*\(cli\.Command, error\)/g,
  )) {
    add(`terraform:command:${match[1]}`, "terraform-commands", "terraform-command", { name: match[1] }, "HANDLED");
  }
  const types = new Map(
    [
      ...sourceText(grammar, "node-types").matchAll(
        /\b(bool|std::string|std::vector<std::string>|int64_t|uint64_t|int|HostPort)\s+(\w+)\b/g,
      ),
    ].map((match) => [match[2], match[1]]),
  );
  for (const call of registrations(sourceText(grammar, "node-options"), "AddOption")) {
    const name = quoted(call)[0];
    if (!name?.startsWith("--")) continue;
    const field = call.match(/&\w+::(\w+)/)?.[1];
    const type = types.get(field);
    const arity = type === "bool" ? 0 : type === "HostPort" ? "optional-equals" : type ? 1 : null;
    add(
      `node:option:${name}`,
      "node-options",
      "node-option",
      { names: [name], field, type: type ?? null, arity },
      arity === null ? "INDETERMINATE" : "HANDLED",
    );
  }
  for (const call of registrations(sourceText(grammar, "node-options"), "AddAlias")) {
    const [name, ...targets] = quoted(call);
    if (!name?.startsWith("-")) continue;
    add(
      `node:alias:${name}`,
      "node-options",
      "node-alias",
      { name, targets },
      targets.length ? "HANDLED" : "INDETERMINATE",
    );
  }
  return members;
}

export function validateGrammarPartition(grammar = DESTRUCTIVE_GRAMMAR) {
  const violations = [];
  for (const source of grammar.sources) {
    const hash = createHash("sha256").update(source.lines.join("\n")).digest("hex");
    if (hash !== source.excerptSha256) violations.push(`${source.id}: authoritative excerpt hash changed.`);
    if (!source.version || !source.citation || source.endLine - source.startLine + 1 !== source.lines.length)
      violations.push(`${source.id}: incomplete source identity or line range.`);
  }
  const expected = new Map(deriveAuthoritativeGrammar(grammar).map((member) => [member.id, member]));
  const seen = new Set();
  for (const member of grammar.partition) {
    if (seen.has(member.id)) violations.push(`${member.id}: duplicate partition member.`);
    seen.add(member.id);
    if (!expected.has(member.id)) violations.push(`${member.id}: unsourced partition member.`);
    else if (JSON.stringify(member) !== JSON.stringify(expected.get(member.id)))
      violations.push(`${member.id}: partition differs from authoritative derivation.`);
  }
  for (const id of expected.keys()) if (!seen.has(id)) violations.push(`${id}: missing partition member.`);
  return { passed: violations.length === 0, members: expected.size, violations };
}

const operators = [
  ";;&",
  "<<<",
  "<<-",
  "&>>",
  "&&",
  "||",
  ";;",
  ";&",
  ">>",
  "<<",
  "<&",
  ">&",
  "<>",
  ">|",
  "&>",
  "|&",
  "(",
  ")",
  ";",
  "&",
  "|",
  "<",
  ">",
  "\n",
];
const redirections = new Set(["<<<", "<<-", "&>>", ">>", "<<", "<&", ">&", "<>", ">|", "&>", "<", ">"]);

function shellClosing(run, start, open = "(", close = ")") {
  let depth = 1;
  let quote = null;
  for (let index = start + 1; index < run.length; index += 1) {
    const character = run[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (quote === '"' && run.startsWith("$(", index)) {
        index = shellClosing(run, index + 1);
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index;
  }
  return run.length;
}

// Words retain expansion identity; quoting removes syntax, not executable position.
// Here-document contents are data, except substitutions in an unquoted delimiter.
export function shellTokens(run) {
  const tokens = [];
  const substitutions = [];
  const errors = [];
  const heredocs = [];
  let pendingHeredoc = null;
  for (let index = 0; index < run.length; ) {
    if (run[index] === "\\" && /[\r\n]/.test(run[index + 1] ?? "")) {
      index += run[index + 1] === "\r" ? 3 : 2;
      continue;
    }
    if (/[ \t\r]/.test(run[index])) {
      index += 1;
      continue;
    }
    if (run[index] === "#") {
      const end = run.indexOf("\n", index);
      index = end < 0 ? run.length : end;
      continue;
    }
    if (run.startsWith("((", index)) {
      const end = shellClosing(run, index + 1);
      collectSubstitutions(run.slice(index + 2, end), substitutions, index + 2);
      tokens.push({ type: "operator", value: "\n", index });
      index = end + 2;
      continue;
    }
    if (run.startsWith("<(", index) || run.startsWith(">(", index)) {
      const end = shellClosing(run, index + 1);
      substitutions.push({ run: run.slice(index + 2, end), index });
      tokens.push({
        type: "word",
        value: run.slice(index, end + 1),
        dynamic: true,
        quoted: false,
        index,
        raw: run.slice(index, end + 1),
      });
      index = end + 1;
      continue;
    }
    const operator = operators.find((candidate) => run.startsWith(candidate, index));
    if (operator) {
      tokens.push({ type: "operator", value: operator, index });
      index += operator.length;
      if (operator === "<<" || operator === "<<-") pendingHeredoc = operator;
      if (operator === "\n") {
        for (const document of heredocs.splice(0)) {
          const start = index;
          let found = false;
          while (index < run.length) {
            const end = run.indexOf("\n", index);
            const lineEnd = end < 0 ? run.length : end;
            let line = run.slice(index, lineEnd).replace(/\r$/, "");
            if (document.stripTabs) line = line.replace(/^\t+/, "");
            if (line === document.delimiter) {
              if (!document.quoted) collectSubstitutions(run.slice(start, index), substitutions, start);
              index = end < 0 ? run.length : end + 1;
              found = true;
              break;
            }
            index = end < 0 ? run.length : end + 1;
          }
          if (!found) errors.push("unterminated here-document");
        }
      }
      continue;
    }
    const start = index;
    let value = "";
    let quote = null;
    let quotedWord = false;
    let dynamic = false;
    while (index < run.length) {
      const character = run[index];
      if (!quote && (/\s/.test(character) || operators.some((candidate) => run.startsWith(candidate, index)))) break;
      if (character === "\\" && quote !== "'") {
        const next = run[index + 1];
        if (next === "\n" || (next === "\r" && run[index + 2] === "\n")) index += next === "\r" ? 3 : 2;
        else if (quote === '"' && !["$", "`", '"', "\\"].includes(next)) {
          value += character;
          index += 1;
        } else {
          value += next ?? "";
          index += 2;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        if (!quote) {
          quote = character;
          quotedWord = true;
          index += 1;
          continue;
        }
        if (quote === character) {
          quote = null;
          index += 1;
          continue;
        }
      }
      if (quote !== "'" && run.startsWith("$(", index)) {
        if (run.startsWith("$((", index)) {
          const end = shellClosing(run, index + 2);
          collectSubstitutions(run.slice(index + 3, end), substitutions, index + 3);
          value += run.slice(index, end + 2);
          dynamic = true;
          index = end + 2;
          continue;
        }
        const end = shellClosing(run, index + 1);
        if (end === run.length) errors.push("unterminated command substitution");
        substitutions.push({ run: run.slice(index + 2, end), index });
        value += run.slice(index, end + 1);
        dynamic = true;
        index = end + 1;
        continue;
      }
      if (quote !== "'" && character === "`") {
        const end = run.indexOf("`", index + 1);
        if (end < 0) {
          errors.push("unterminated backtick substitution");
          index = run.length;
          break;
        }
        substitutions.push({ run: run.slice(index + 1, end), index });
        value += run.slice(index, end + 1);
        dynamic = true;
        index = end + 1;
        continue;
      }
      if (quote !== "'" && character === "$" && run[index + 1] === "{") {
        const end = shellClosing(run, index + 1, "{", "}");
        collectSubstitutions(run.slice(index + 2, end), substitutions, index + 2);
        value += run.slice(index, end + 1);
        dynamic = true;
        index = end + 1;
        continue;
      }
      if (quote !== "'" && character === "$") dynamic = true;
      value += character;
      index += 1;
    }
    if (quote) errors.push("unterminated quoted word");
    const token = { type: "word", value, dynamic, quoted: quotedWord, index: start, raw: run.slice(start, index) };
    tokens.push(token);
    if (pendingHeredoc) {
      heredocs.push({ delimiter: value, quoted: quotedWord, stripTabs: pendingHeredoc === "<<-" });
      pendingHeredoc = null;
    }
  }
  return { tokens, substitutions, errors };
}

function collectSubstitutions(run, results, offset) {
  for (let index = 0; index < run.length; index += 1) {
    if (run[index] === "\\") {
      index += 1;
      continue;
    }
    if (run.startsWith("$(", index)) {
      const end = shellClosing(run, index + 1);
      results.push({ run: run.slice(index + 2, end), index: offset + index });
      index = end;
    }
  }
}

function commandsFromTokens(tokens) {
  const commands = [];
  let words = [];
  let redirects = [];
  let header = null;
  let pattern = false;
  let caseDepth = 0;
  let arrayDepth = 0;
  const flush = () => {
    if (words.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = token.value;
    if (header) {
      if (header === "case" && value === "in") {
        header = null;
        pattern = true;
      } else if (header === "for" && value === "do") header = null;
      continue;
    }
    if (pattern) {
      if (value === ")") pattern = false;
      else if (value === "esac") {
        pattern = false;
        caseDepth -= 1;
      }
      continue;
    }
    if (arrayDepth) {
      if (value === "(") arrayDepth += 1;
      if (value === ")") arrayDepth -= 1;
      continue;
    }
    if (redirections.has(value) && token.type === "operator") {
      if (
        words.at(-1)?.value.match(/^(?:\d+|\{[A-Za-z_]\w*\})$/) &&
        words.at(-1).index + words.at(-1).raw.length === token.index
      )
        words.pop();
      redirects.push({ operator: value, target: tokens[++index] });
      continue;
    }
    if (token.type === "operator") {
      if (value === "(" && words.at(-1)?.value.match(/^[A-Za-z_]\w*=$/)) {
        words.pop();
        arrayDepth = 1;
      } else if (value === "(" && tokens[index + 1]?.value === ")") {
        words = [];
        index += 1;
      } else {
        flush();
        if ([";;", ";&", ";;&"].includes(value) && caseDepth) pattern = true;
      }
      continue;
    }
    if (!words.length && /^[A-Za-z_]\w*=/.test(token.raw ?? "")) continue;
    if (!words.length && !token.quoted) {
      if (value === "case") {
        header = "case";
        caseDepth += 1;
        continue;
      }
      if (value === "for" || value === "select") {
        header = "for";
        continue;
      }
      if (value === "function") {
        index += 1;
        continue;
      }
      if (["if", "then", "elif", "else", "while", "until", "do", "!", "{", "}", "fi", "done", "esac"].includes(value)) {
        if (value === "esac") caseDepth = Math.max(0, caseDepth - 1);
        continue;
      }
      if (/^[A-Za-z_]\w*=/.test(value)) continue;
    }
    words.push(token);
  }
  flush();
  return commands;
}

function forms(grammar, surface) {
  return grammar.partition
    .filter((member) => member.surface === surface && member.disposition === "HANDLED")
    .map((member) => member.form);
}

function consumeOptions(words, start, options) {
  let index = start;
  const used = [];
  for (; index < words.length && words[index].value.startsWith("-"); index += 1) {
    const value = words[index].value;
    if (value === "-") return { index, used };
    if (value === "--") return { index: index + 1, used };
    const [name, ...inline] = value.split("=");
    let option = options.find((candidate) => candidate.names.includes(name));
    if (!option && name.startsWith("--no-"))
      option = options.find(
        (candidate) => candidate.arity === 0 && candidate.names.includes(name.replace("--no-", "--")),
      );
    if (!option) {
      const short = options.find(
        (candidate) =>
          candidate.arity === 1 &&
          candidate.names.some((alias) => alias.length === 2 && value.startsWith(alias) && value.length > 2),
      );
      if (short) {
        used.push(short.names.find((alias) => alias.length === 2 && value.startsWith(alias)));
        continue;
      }
      return { index, reason: `unlisted option ${name}` };
    }
    used.push(name);
    if (option.arity === "equals" && (!inline.length || !inline.join("=")))
      return { index, reason: `${name} requires =value` };
    if (option.arity === 1 && !inline.length) {
      if (!words[index + 1]) return { index, reason: `${name} requires a value` };
      index += 1;
    }
  }
  return { index, used };
}

const scriptOperations = new Map([
  ["digitalocean-registry-cleanup.mjs", "script:digitalocean-registry-cleanup"],
  ["production-db-restore-point-cleanup.mjs", "script:production-db-restore-point-cleanup"],
  ["disable-terraform-prevent-destroy.mjs", "script:disable-terraform-prevent-destroy"],
]);

function classifyCommand(command, grammar) {
  let words = command.words;
  const wrapper = words[0]?.value;
  if (["time", "coproc"].includes(wrapper)) {
    let inner = words.slice(1);
    while (inner[0]?.value.startsWith("-")) inner = inner.slice(1);
    const classification = classifyCommand({ ...command, words: inner }, grammar);
    return classification
      ? {
          ...classification,
          operation: null,
          disposition: "INDETERMINATE",
          reason: `unsupported ${wrapper} production`,
        }
      : null;
  }
  if (["command", "exec"].includes(words[0]?.value)) {
    words = words.slice(1);
    if (wrapper === "command" && ["-v", "-V"].includes(words[0]?.value)) return null;
    if (wrapper === "command" && words[0]?.value === "-p") words = words.slice(1);
    if (words[0]?.value === "--") words = words.slice(1);
  }
  if (words[0]?.value === "env") {
    words = words.slice(1);
    while (words[0]?.value.match(/^[A-Za-z_]\w*=/)) words = words.slice(1);
  }
  const tool = basename(words[0]?.value ?? "");
  const unknown = (reason) => ({ disposition: "INDETERMINATE", tool, reason, index: words[0]?.index, command });
  const benign = () => ({ disposition: "HANDLED", tool, operation: null, index: words[0]?.index, command });
  const destructive = (operation) => ({ ...benign(), operation });
  const directOperation = scriptOperations.get(tool);
  if (directOperation) return destructive(directOperation);
  if (!["terraform", "doctl", "node"].includes(tool)) return null;
  if (words[0].dynamic && !/^[A-Za-z0-9_.-]+$/.test(tool)) return unknown("dynamic executable");
  if (tool === "terraform") {
    const options = consumeOptions(words, 1, forms(grammar, "terraform-option"));
    if (options.reason) return unknown(options.reason);
    const subcommand = words[options.index];
    if (!subcommand) return benign();
    if (
      subcommand.dynamic ||
      !forms(grammar, "terraform-command").some(
        (form) => form.name === subcommand.value || form.name.startsWith(`${subcommand.value} `),
      )
    )
      return unknown("unlisted Terraform command");
    return subcommand.value === "destroy" ? destructive("terraform:destroy") : benign();
  }
  if (tool === "doctl") {
    const options = forms(grammar, "doctl-option");
    let position = consumeOptions(words, 1, options);
    if (position.reason) return unknown(position.reason);
    const root = words[position.index];
    if (!root) return benign();
    const groups = forms(grammar, "doctl-group");
    if (!groups.find((group) => group.names[0] === "registry")?.names.includes(root.value)) {
      const roots = forms(grammar, "doctl-root").map((form) => form.registration.replace(/Cmd$/, "").toLowerCase());
      return !root.dynamic && roots.includes(root.value.replaceAll("-", ""))
        ? benign()
        : unknown("unlisted doctl root command");
    }
    position = consumeOptions(words, position.index + 1, options);
    if (position.reason) return unknown(position.reason);
    const group = groups.find((candidate) => candidate.names.includes(words[position.index]?.value));
    if (!group) {
      return forms(grammar, "doctl-command").some(
        (form) => form.group === "registry" && form.names.includes(words[position.index]?.value),
      )
        ? benign()
        : unknown("unlisted registry command");
    }
    position = consumeOptions(words, position.index + 1, options);
    if (position.reason) return unknown(position.reason);
    const form = forms(grammar, "doctl-command").find(
      (candidate) => candidate.group === group.names[0] && candidate.names.includes(words[position.index]?.value),
    );
    if (!form) return unknown("unlisted registry subcommand");
    if (group.names[0] === "repository" && form.names[0] === "delete-tag")
      return destructive("doctl:registry-repository-delete-tag");
    if (group.names[0] === "garbage-collection" && form.names[0] === "start")
      return destructive("doctl:registry-garbage-collection-start");
    return benign();
  }
  const options = forms(grammar, "node-option");
  for (const alias of forms(grammar, "node-alias")) {
    const target = options.find((option) => option.names.includes(alias.targets[0]));
    if (target && !alias.name.includes(" ") && !alias.name.endsWith("="))
      options.push({ ...target, names: [alias.name], targets: alias.targets });
  }
  const consumed = consumeOptions(words, 1, options);
  if (consumed.reason) return unknown(consumed.reason);
  const usedOptions = consumed.used;
  if (
    usedOptions.some((name) =>
      ["--eval", "--print", "-e", "-p", "-pe", "--check", "-c", "--help", "-h", "--version", "-v", "--run"].includes(
        name,
      ),
    )
  )
    return benign();
  const script = words[consumed.index];
  if (!script || script.value === "-") return benign();
  if (script.dynamic && !/^[A-Za-z0-9_.-]+$/.test(basename(script.value)))
    return unknown("dynamic Node script position");
  const operation = scriptOperations.get(basename(script.value));
  return operation ? { ...destructive(operation), scriptIndex: consumed.index, words } : benign();
}

export function classifyShellCommands(run, { grammar = DESTRUCTIVE_GRAMMAR } = {}) {
  if (typeof run !== "string") return { invocations: [], operations: [], indeterminate: [] };
  const lexed = shellTokens(run);
  const invocations = commandsFromTokens(lexed.tokens)
    .map((command) => classifyCommand(command, grammar))
    .filter(Boolean);
  for (const substitution of lexed.substitutions) {
    for (const invocation of classifyShellCommands(substitution.run, { grammar }).invocations)
      invocations.push({ ...invocation, index: substitution.index + invocation.index });
  }
  if (lexed.errors.length) {
    for (const invocation of invocations) {
      invocation.disposition = "INDETERMINATE";
      invocation.reason = lexed.errors.join(", ");
    }
  }
  invocations.sort((left, right) => left.index - right.index);
  return {
    invocations,
    operations: invocations.filter((invocation) => invocation.operation).map((invocation) => invocation.operation),
    indeterminate: invocations.filter((invocation) => invocation.disposition === "INDETERMINATE"),
  };
}

export const DESTRUCTIVE_OPERATION_EXEMPTIONS = [
  {
    workflowFile: ".github/workflows/platform-preview-cleanup.yml",
    jobs: [
      {
        jobId: "destroy-preview",
        expectedStepOperations: [["script:disable-terraform-prevent-destroy"], ["terraform:destroy"]],
      },
    ],
  },
  {
    workflowFile: ".github/workflows/platform-production.yml",
    jobs: [{ jobId: "deploy-production", expectedStepOperations: [["script:production-db-restore-point-cleanup"]] }],
  },
  {
    workflowFile: ".github/workflows/platform-staging-reset.yml",
    jobs: [
      {
        jobId: "reset-staging",
        expectedStepOperations: [
          ["script:disable-terraform-prevent-destroy", "terraform:destroy"],
          ["script:disable-terraform-prevent-destroy", "terraform:destroy"],
        ],
      },
    ],
  },
];
export const NAMED_RESET_WORKFLOW_TRIPWIRES = [
  ".github/workflows/platform-staging-reset.yml",
  ".github/workflows/catalog-integration-staging-reset.yml",
];

function expression(value) {
  return typeof value === "string"
    ? value
        .trim()
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function environment(...owners) {
  return Object.assign({}, ...owners.map((owner) => owner?.env ?? {}));
}

function inputVariables(env, input) {
  return Object.entries(env)
    .filter(([, value]) => expression(value) === `github.event.inputs.${input}`)
    .map(([name]) => name);
}

function needs(job) {
  return typeof job?.needs === "string" ? [job.needs] : Array.isArray(job?.needs) ? job.needs : [];
}

function noConfirmationDefault(input) {
  return input?.type === "string" && !Object.hasOwn(input, "default");
}

function nonzeroExit(tokens) {
  return commandsFromTokens(tokens).some(
    ({ words }) => words[0]?.value === "exit" && /^[1-9]\d*$/.test(words[1]?.value ?? ""),
  );
}

function tokenValues(tokens) {
  return tokens.filter((token) => token.value !== "\n").map((token) => token.value);
}

function sequenceAt(tokens, values) {
  const actual = tokenValues(tokens);
  return actual.findIndex((_, index) => values.every((value, offset) => actual[index + offset] === value));
}

// Only case branches used by the cleanup contracts are interpreted here. This
// is a shape proof, not the dataflow/ownership or reachability proof of #6130/31.
function caseAt(tokens, start) {
  if (tokens[start]?.value !== "case" || tokens[start + 2]?.value !== "in") return null;
  const selector = tokens[start + 1];
  const branches = [];
  let index = start + 3;
  while (index < tokens.length) {
    while (tokens[index]?.value === "\n") index += 1;
    if (tokens[index]?.value === "esac") return { selector, branches, end: index };
    const patterns = [];
    while (index < tokens.length && tokens[index].value !== ")") {
      if (!["|", "(", "\n"].includes(tokens[index].value)) patterns.push(tokens[index].value);
      index += 1;
    }
    if (index === tokens.length) return null;
    const bodyStart = ++index;
    let nested = 0;
    for (; index < tokens.length; index += 1) {
      if (tokens[index].value === "case") nested += 1;
      if (tokens[index].value === "esac") nested -= 1;
      if (nested === 0 && tokens[index].value === ";;") break;
    }
    if (index === tokens.length) return null;
    branches.push({ patterns, tokens: tokens.slice(bodyStart, index) });
    index += 1;
  }
  return null;
}

function cases(tokens) {
  return tokens.flatMap((token, index) =>
    token.value === "case" && !token.quoted ? [caseAt(tokens, index)].filter(Boolean) : [],
  );
}

function branch(control, pattern) {
  return control?.branches.find((candidate) => candidate.patterns.length === 1 && candidate.patterns[0] === pattern);
}

function exactComparisonRefusal(tokens, variable, phrase = null) {
  const significant = tokens.filter((token) => token.value !== "\n");
  const values = significant.map((token) => token.value);
  for (let index = 0; index < values.length; index += 1) {
    if (
      values[index] !== "if" ||
      values[index + 1] !== "[" ||
      ![`$${variable}`, `\${${variable}}`].includes(values[index + 2]) ||
      values[index + 3] !== "!="
    )
      continue;
    const compared = values[index + 4];
    if (
      !compared ||
      (phrase !== null && compared !== phrase) ||
      values[index + 5] !== "]" ||
      values[index + 6] !== ";" ||
      values[index + 7] !== "then"
    )
      continue;
    const thenIndex = index + 7;
    const end = significant.findIndex((token, tokenIndex) => tokenIndex > thenIndex && token.value === "fi");
    if (
      end > thenIndex &&
      nonzeroExit(tokens.slice(tokens.indexOf(significant[thenIndex]) + 1, tokens.indexOf(significant[end])))
    )
      return compared;
  }
  return null;
}

function confirmationGate(workflow) {
  const job = workflow.jobs?.["refuse-unconfirmed-apply"];
  if (!job || expression(job.if) !== "github.event_name == 'workflow_dispatch'" || job["continue-on-error"])
    return false;
  return (job.steps ?? []).some((step) => {
    if (typeof step.run !== "string" || step.if || step["continue-on-error"]) return false;
    const env = environment(workflow, job, step);
    const modeNames = inputVariables(env, "dry_run");
    const confirmationNames = inputVariables(env, "confirm");
    return cases(shellTokens(step.run).tokens).some(
      (control) =>
        control.selector.dynamic &&
        modeNames.some((name) => [`$${name}`, `\${${name}}`].includes(control.selector.value)) &&
        control.branches.length === 3 &&
        branch(control, "true") &&
        branch(control, "false") &&
        branch(control, "*") &&
        confirmationNames.some((name) => exactComparisonRefusal(branch(control, "false").tokens, name)) &&
        nonzeroExit(branch(control, "*").tokens),
    );
  });
}

function publications(tokens) {
  return commandsFromTokens(tokens).flatMap(({ words, redirects }) => {
    if (
      words[0]?.value !== "echo" ||
      words.length !== 2 ||
      !words[1].dynamic ||
      !redirects.some(
        (redirect) => redirect.operator === ">>" && redirect.target?.dynamic && redirect.target.value === "$GITHUB_ENV",
      )
    )
      return [];
    const match = words[1].value.match(/^([A-Z][A-Z0-9_]*)=\$\{?([A-Za-z_]\w*)\}?$/);
    return match ? [{ target: match[1], variable: match[2] }] : [];
  });
}

function assignment(tokens, variable, value) {
  return sequenceAt(tokens, [`${variable}=${value}`]) >= 0;
}

function safeResolvers(workflow, job) {
  const candidates = [];
  for (const step of job.steps ?? []) {
    if (typeof step.run !== "string") continue;
    const tokens = shellTokens(step.run).tokens;
    const env = environment(workflow, job, step);
    const controls = cases(tokens);
    for (const publication of publications(tokens)) {
      if (publication.target === publication.variable) continue;
      const registry = controls.some((control) => {
        const name = control.selector.value.replace(/^\$\{?|\}$/g, "");
        const requested = expression(env[name]);
        return (
          control.selector.dynamic &&
          publication.variable === name &&
          requested === "github.event_name == 'schedule' && 'false' || github.event.inputs.dry_run" &&
          control.branches.length === 2 &&
          control.branches[0].patterns.join(",") === "true,false" &&
          publications(control.branches[0].tokens).some(
            (output) => output.target === publication.target && output.variable === name,
          ) &&
          branch(control, "*") &&
          nonzeroExit(branch(control, "*").tokens)
        );
      });
      const restore = controls.some((control) => {
        if (
          !control.selector.dynamic ||
          control.selector.value !== "$GITHUB_EVENT_NAME" ||
          control.branches.length !== 3
        )
          return false;
        const schedule = branch(control, "schedule");
        const manual = branch(control, "workflow_dispatch");
        const unknown = branch(control, "*");
        if (
          !schedule ||
          !manual ||
          !unknown ||
          !assignment(schedule.tokens, publication.variable, "true") ||
          !nonzeroExit(unknown.tokens)
        )
          return false;
        return cases(manual.tokens).some(
          (mode) =>
            inputVariables(env, "dry_run").some(
              (name) => mode.selector.dynamic && [`$${name}`, `\${${name}}`].includes(mode.selector.value),
            ) &&
            mode.branches.length === 3 &&
            branch(mode, "true") &&
            branch(mode, "false") &&
            branch(mode, "*") &&
            assignment(branch(mode, "true").tokens, publication.variable, "false") &&
            assignment(branch(mode, "false").tokens, publication.variable, "true") &&
            nonzeroExit(branch(mode, "*").tokens),
        );
      });
      if (registry || restore) candidates.push({ ...publication, kind: registry ? "dry-run" : "apply" });
    }
  }
  return candidates.length === 1 ? candidates : [];
}

function modeWiring(detected, resolver, workflow) {
  return detected.classification.invocations
    .filter((invocation) => invocation.operation)
    .every((invocation) => {
      const args = invocation.words?.slice(invocation.scriptIndex + 1) ?? [];
      if (invocation.operation === "script:digitalocean-registry-cleanup" && resolver.kind === "dry-run") {
        return args.some(
          (word) =>
            word.dynamic && [`--dry-run=$${resolver.target}`, `--dry-run=\${${resolver.target}}`].includes(word.value),
        );
      }
      if (invocation.operation !== "script:production-db-restore-point-cleanup" || resolver.kind !== "apply")
        return false;
      const applyEnvironment = environment(
        workflow,
        detected.job,
        detected.step,
      ).PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY;
      if (applyEnvironment !== undefined && applyEnvironment !== "false") return false;
      const tokens = shellTokens(detected.step.run).tokens;
      return cases(tokens).some((control) => {
        if (
          !control.selector.dynamic ||
          ![`$${resolver.target}`, `\${${resolver.target}}`].includes(control.selector.value) ||
          control.branches.length !== 3
        )
          return false;
        const apply = branch(control, "true");
        const dryRun = branch(control, "false");
        const unknown = branch(control, "*");
        if (!apply || !dryRun || !unknown || !nonzeroExit(unknown.tokens)) return false;
        for (const token of apply.tokens) {
          const name = token.value.match(/^([A-Za-z_]\w*)=$/)?.[1];
          if (
            name &&
            sequenceAt(apply.tokens, [`${name}=`, "(", "--apply", ")"]) >= 0 &&
            sequenceAt(dryRun.tokens, [`${name}=`, "(", ")"]) >= 0 &&
            args.some((argument) => argument.dynamic && argument.value === `\${${name}[@]}`) &&
            !args.some((argument) => argument.value === "--apply")
          )
            return true;
        }
        return false;
      });
    });
}

function safeDependency(job) {
  return (
    needs(job).includes("refuse-unconfirmed-apply") &&
    expression(job.if) ===
      "!cancelled() && (needs.refuse-unconfirmed-apply.result == 'skipped' || needs.refuse-unconfirmed-apply.result == 'success')"
  );
}

function parseWorkflow(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  const workflow = document.toJS();
  if (
    !workflow ||
    typeof workflow !== "object" ||
    Array.isArray(workflow) ||
    !workflow.jobs ||
    typeof workflow.jobs !== "object" ||
    Array.isArray(workflow.jobs) ||
    Object.values(workflow.jobs).some(
      (job) => !job || typeof job !== "object" || (job.steps !== undefined && !Array.isArray(job.steps)),
    )
  )
    throw new Error("workflow must contain a jobs mapping");
  return workflow;
}

export function checkWorkflowDestructiveOperationGating(
  source,
  { workflowFile = "workflow", grammar = DESTRUCTIVE_GRAMMAR } = {},
) {
  const violations = [];
  const checkedSteps = [];
  let workflow;
  try {
    workflow = parseWorkflow(source);
  } catch (error) {
    return {
      passed: false,
      checkedSteps,
      violations: [`${workflowFile}: workflow could not be parsed; failing closed (${error.message}).`],
    };
  }
  const detected = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const [index, step] of (job?.steps ?? []).entries()) {
      if (typeof step?.run !== "string") continue;
      const classification = classifyShellCommands(step.run, { grammar });
      if (!classification.operations.length && !classification.indeterminate.length) continue;
      const entry = { jobId, job, step, stepIndex: index + 1, classification, operations: classification.operations };
      detected.push(entry);
      for (const unknown of classification.indeterminate)
        violations.push(
          `${workflowFile}: job '${jobId}' step #${index + 1}: INDETERMINATE ${unknown.tool}: ${unknown.reason}; failing closed.`,
        );
    }
  }
  const exempt = new Set();
  const inventory = DESTRUCTIVE_OPERATION_EXEMPTIONS.find((entry) => entry.workflowFile === workflowFile);
  for (const declared of inventory?.jobs ?? []) {
    const actual = detected.filter((entry) => entry.jobId === declared.jobId);
    const signatures = (entries) => entries.map((operations) => [...operations].sort().join("+")).sort();
    if (
      actual.some((entry) => entry.classification.indeterminate.length) ||
      JSON.stringify(signatures(actual.map((entry) => entry.operations))) !==
        JSON.stringify(signatures(declared.expectedStepOperations))
    ) {
      violations.push(
        `${workflowFile}: bounded destructive-operation exemption for job '${declared.jobId}' changed; exact invocation multiset required (no additions, removals, or INDETERMINATE forms).`,
      );
    } else for (const entry of actual) exempt.add(entry);
  }
  for (const entry of detected)
    checkedSteps.push({
      jobId: entry.jobId,
      stepIndex: entry.stepIndex,
      name: entry.step.name ?? "unnamed step",
      operations: entry.operations,
      disposition: entry.classification.indeterminate.length
        ? "INDETERMINATE"
        : exempt.has(entry)
          ? "bounded-exemption"
          : "provable-gate",
    });
  const gated = detected.filter((entry) => !exempt.has(entry));
  if (gated.length) {
    const triggers =
      typeof workflow.on === "string"
        ? [workflow.on]
        : Array.isArray(workflow.on)
          ? workflow.on
          : Object.keys(workflow.on ?? {});
    if (triggers.sort().join(",") !== "schedule,workflow_dispatch")
      violations.push(
        `${workflowFile}: gated destructive workflow must be triggered only by schedule and workflow_dispatch.`,
      );
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    if (
      inputs.dry_run?.type !== "choice" ||
      inputs.dry_run.default !== "true" ||
      [...(inputs.dry_run.options ?? [])].sort().join(",") !== "false,true"
    )
      violations.push(`${workflowFile}: dry_run must be a true/false choice that defaults to "true".`);
    if (!noConfirmationDefault(inputs.confirm))
      violations.push(`${workflowFile}: confirm must be a typed string confirmation input without a default.`);
    if (!confirmationGate(workflow))
      violations.push(
        `${workflowFile}: refuse-unconfirmed-apply must shell-validate every manual mode, compare confirmation case-sensitively, and refuse invalid, empty, unknown or unconfirmed values with a nonzero exit.`,
      );
  }
  for (const entry of gated) {
    if (!safeDependency(entry.job))
      violations.push(
        `${workflowFile}: destructive job '${entry.jobId}' must be cancellation-safe, need refuse-unconfirmed-apply, and accept only skipped or success.`,
      );
    const resolvers = safeResolvers(workflow, entry.job);
    if (!resolvers.length)
      violations.push(
        `${workflowFile}: job '${entry.jobId}' requires a single fail-closed shell resolver with a distinct resolved name.`,
      );
    else if (!modeWiring(entry, resolvers[0], workflow))
      violations.push(
        `${workflowFile}: job '${entry.jobId}' step #${entry.stepIndex} cannot associate its invocation with the provable dry-run/apply resolver.`,
      );
  }
  return { passed: violations.length === 0, checkedSteps, violations };
}

export function checkNamedResetWorkflowTripwires(workflowSources) {
  const violations = [];
  for (const file of NAMED_RESET_WORKFLOW_TRIPWIRES) {
    let workflow;
    try {
      workflow = parseWorkflow(workflowSources[file]);
    } catch (error) {
      violations.push(`${file}: named reset workflow source is missing or malformed (${error.message}).`);
      continue;
    }
    const input = workflow.on?.workflow_dispatch?.inputs?.confirm;
    if (file.endsWith("/platform-staging-reset.yml")) {
      const job = workflow.jobs["reset-staging"];
      const step = job?.steps?.find(
        (candidate) =>
          expression(candidate.env?.RESET_CONFIRM) === "inputs.confirm" && typeof candidate.run === "string",
      );
      const tokens = shellTokens(step?.run ?? "").tokens;
      if (
        !noConfirmationDefault(input) ||
        !step ||
        !["reset staging", "resume staging recreate"].every((phrase) =>
          exactComparisonRefusal(tokens, "RESET_CONFIRM", phrase),
        )
      )
        violations.push(
          `${file}: named reset tripwire requires an unset-by-default typed confirmation and actual nonzero refusal for both exact phrases.`,
        );
    } else {
      const gate = workflow.jobs["refuse-unconfirmed-apply"];
      const job = workflow.jobs["catalog-integration-reset"];
      const condition = expression(gate?.if);
      if (
        !noConfirmationDefault(input) ||
        condition !== "inputs.action == 'apply' && inputs.confirm != 'reset staging catalog integration data'" ||
        gate?.["continue-on-error"] ||
        !(gate?.steps ?? []).some(
          (step) =>
            typeof step.run === "string" && !step["continue-on-error"] && nonzeroExit(shellTokens(step.run).tokens),
        ) ||
        !["refuse-production", "refuse-unconfirmed-apply"].every((name) => needs(job).includes(name)) ||
        expression(job?.if) !==
          "!cancelled() && needs.refuse-production.result == 'skipped' && needs.refuse-unconfirmed-apply.result == 'skipped'"
      )
        violations.push(
          `${file}: named reset tripwire requires actual nonzero refusal plus a cancellation-safe destructive-job dependency/result condition.`,
        );
    }
  }
  return { passed: violations.length === 0, checkedWorkflows: [...NAMED_RESET_WORKFLOW_TRIPWIRES], violations };
}

export function discoverWorkflowFiles(root = process.cwd()) {
  const directory = join(root, ".github/workflows");
  const visit = (path, prefix) =>
    readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const relative = `${prefix}/${entry.name}`;
        return entry.isDirectory()
          ? visit(join(path, entry.name), relative)
          : entry.isFile() && /\.ya?ml$/.test(entry.name)
            ? [relative]
            : [];
      });
  return visit(directory, ".github/workflows");
}

export function checkDiscoveredWorkflows({ root = process.cwd(), grammar = DESTRUCTIVE_GRAMMAR } = {}) {
  const workflowFiles = discoverWorkflowFiles(root);
  const sources = {};
  const results = [];
  const violations = [...validateGrammarPartition(grammar).violations];
  for (const workflowFile of workflowFiles) {
    try {
      sources[workflowFile] = readFileSync(resolve(root, workflowFile), "utf8");
      const result = checkWorkflowDestructiveOperationGating(sources[workflowFile], { workflowFile, grammar });
      results.push({ workflowFile, ...result });
      violations.push(...result.violations);
    } catch (error) {
      violations.push(`${workflowFile}: inspection failed; failing closed (${error.message}).`);
    }
  }
  const tripwires = checkNamedResetWorkflowTripwires(sources);
  violations.push(...tripwires.violations);
  for (const exemption of DESTRUCTIVE_OPERATION_EXEMPTIONS)
    if (!Object.hasOwn(sources, exemption.workflowFile))
      violations.push(`${exemption.workflowFile}: bounded exemption workflow is missing.`);
  return {
    passed: violations.length === 0,
    total: workflowFiles.length,
    scanned: results.length,
    results,
    tripwires,
    violations,
  };
}

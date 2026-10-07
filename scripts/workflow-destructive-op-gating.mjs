import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseDocument } from "yaml";

export const DESTRUCTIVE_GRAMMAR = JSON.parse(
  readFileSync(new URL("./workflow-destructive-op-gating-grammar.json", import.meta.url), "utf8"),
);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function authoritativeText(grammar, id) {
  const source = grammar.sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`Missing authoritative source ${id}.`);
  return source.lines.join("\n");
}

// Index of the delimiter closing the group opened at `start`, skipping C/Go
// string literals and comments; the text length when the group never closes.
function sourceGroupEnd(text, start, open = "(", close = ")") {
  let depth = 1;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      for (index += 1; index < text.length && text[index] !== character; index += 1) {
        if (text[index] === "\\") index += 1;
      }
    } else if (text.startsWith("/*", index)) index = text.indexOf("*/", index + 2) + 1;
    else if (text.startsWith("//", index)) index = text.indexOf("\n", index + 2);
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

function callArguments(text, callee) {
  return [...text.matchAll(new RegExp(`\\b${callee}\\s*\\(`, "g"))].map((match) => {
    const open = match.index + match[0].length - 1;
    return text.slice(open + 1, sourceGroupEnd(text, open));
  });
}

const stringLiterals = (text) => [...text.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));

// Yacc rules section of parse.y: actions and comments removed, character
// literals kept, then `name: alternative | alternative ;` split per alternative.
function yaccAlternatives(text) {
  const start = text.indexOf("%%") + 2;
  let rules = "";
  for (let index = start; index < text.length; index += 1) {
    if (text.startsWith("%%", index)) break;
    if (text.startsWith("/*", index)) {
      index = text.indexOf("*/", index + 2) + 1;
      continue;
    }
    if (text[index] === "{") {
      index = sourceGroupEnd(text, index, "{", "}");
      continue;
    }
    if (text[index] === "'") {
      const literal = /^'(?:\\.|[^'\\])*'/.exec(text.slice(index));
      if (literal) {
        rules += literal[0];
        index += literal[0].length - 1;
      }
      continue;
    }
    rules += text[index];
  }
  const symbols = rules.match(/'(?:\\.|[^'\\])*'|\w+|[:|;]/g) ?? [];
  const alternatives = [];
  let production = null;
  let rhs = [];
  for (let index = 0; index < symbols.length; index += 1) {
    if (production === null) {
      if (symbols[index + 1] === ":") {
        production = symbols[index];
        index += 1;
      }
      continue;
    }
    if (symbols[index] === "|" || symbols[index] === ";") {
      alternatives.push({ production, rhs: rhs.join(" ") });
      rhs = [];
      if (symbols[index] === ";") production = null;
    } else rhs.push(symbols[index]);
  }
  return alternatives;
}

const handledShellProductions = new Set(
  [
    "inputunit simple_list_terminator nullcmd_terminator word_list redirection redirection_list",
    "simple_command_element simple_command command shell_command subshell group_command",
    "list0 list1 simple_list simple_list1 pipeline pipeline_command compound_list newline_list list_terminator",
    "case_command case_clause case_clause_sequence pattern pattern_list if_command elif_clause for_command",
    "function_def function_body arith_command cond_command comsub",
  ]
    .join(" ")
    .split(" "),
);
const unsupportedShellSymbol = /\b(?:arith_for_command|select_command|coproc|timespec|funsub|error)\b/;

export function deriveAuthoritativeGrammar(grammar = DESTRUCTIVE_GRAMMAR) {
  const members = [];
  const member = (id, source, surface, form, disposition) => members.push({ id, source, surface, form, disposition });

  for (const { production, rhs } of yaccAlternatives(authoritativeText(grammar, "bash"))) {
    const handled = handledShellProductions.has(production) && !unsupportedShellSymbol.test(rhs);
    member(`bash:${production}:${rhs}`, "bash", "shell", { production, rhs }, handled ? "HANDLED" : "INDETERMINATE");
  }

  const doctlConstants = new Map(
    Array.from(authoritativeText(grammar, "doctl-constants").matchAll(/\b(Arg\w+)\s*=\s*"([^"\n]+)"/g), (match) => [
      match[1],
      match[2],
    ]),
  );
  const doctlGlobal = authoritativeText(grammar, "doctl-global");
  const flagPattern = /rootPFlagSet\.(String|Bool|Int)Var(P)?\([^,]+,\s*("[^"]+"|doctl\.\w+)(?:,\s*"([^"]*)")?/g;
  for (const [, kind, short, nameExpression, shorthand] of doctlGlobal.matchAll(flagPattern)) {
    const name = nameExpression.startsWith('"')
      ? JSON.parse(nameExpression)
      : doctlConstants.get(nameExpression.slice("doctl.".length));
    const names = [`--${name}`];
    if (short && shorthand) names.push(`-${shorthand}`);
    member(
      `doctl:option:${name}`,
      "doctl-global",
      "doctl-option",
      { names, arity: kind === "Bool" ? 0 : 1 },
      name ? "HANDLED" : "INDETERMINATE",
    );
  }
  for (const [, registration] of doctlGlobal.matchAll(/DoitCmd\.AddCommand\((\w+)\(\)\)/g))
    member(`doctl:root:${registration}`, "doctl-global", "doctl-root", { registration }, "HANDLED");

  const registry = authoritativeText(grammar, "doctl-registry");
  for (const [, use, aliases] of registry.matchAll(/Use:\s*"([^"]+)"[\s\S]*?Aliases:\s*\[\]string\{([^}]+)\}/g))
    member(
      `doctl:group:${use}`,
      "doctl-registry",
      "doctl-group",
      { names: [use, ...stringLiterals(aliases)] },
      "HANDLED",
    );
  for (const call of callArguments(registry, "CmdBuilder")) {
    const handler = /\bRun\w+/.exec(call)?.[0];
    const name = stringLiterals(call)[0]?.split(" ")[0];
    if (!handler || !name) continue;
    let group = "registry";
    if (handler.includes("Repository")) group = "repository";
    else if (handler.includes("GarbageCollection")) group = "garbage-collection";
    const aliases = callArguments(call, "aliasOpt").flatMap(stringLiterals);
    member(
      `doctl:command:${group}:${name}`,
      "doctl-registry",
      "doctl-command",
      { group, names: [name, ...aliases] },
      "HANDLED",
    );
  }

  for (const [, name] of authoritativeText(grammar, "terraform-global").matchAll(/const argName = "([^"]+)"/g))
    member(
      `terraform:option:${name}`,
      "terraform-global",
      "terraform-option",
      { names: [name], arity: "equals" },
      "HANDLED",
    );
  for (const [, name] of authoritativeText(grammar, "terraform-commands").matchAll(
    /"([^"]+)":\s*func\(\)\s*\(cli\.Command, error\)/g,
  ))
    member(`terraform:command:${name}`, "terraform-commands", "terraform-command", { name }, "HANDLED");

  const fieldTypes = new Map(
    Array.from(
      authoritativeText(grammar, "node-types").matchAll(
        /\b(bool|std::string|std::vector<std::string>|int64_t|uint64_t|int|HostPort)\s+(\w+)\b/g,
      ),
      (match) => [match[2], match[1]],
    ),
  );
  const nodeOptions = authoritativeText(grammar, "node-options");
  for (const call of callArguments(nodeOptions, "AddOption")) {
    const name = stringLiterals(call)[0];
    if (!name?.startsWith("--")) continue;
    const field = /&\w+::(\w+)/.exec(call)?.[1];
    const type = fieldTypes.get(field) ?? null;
    let arity = null;
    if (type === "bool") arity = 0;
    else if (type === "HostPort") arity = "optional-equals";
    else if (type) arity = 1;
    member(
      `node:option:${name}`,
      "node-options",
      "node-option",
      { names: [name], field, type, arity },
      arity === null ? "INDETERMINATE" : "HANDLED",
    );
  }
  for (const call of callArguments(nodeOptions, "AddAlias")) {
    const [name, ...targets] = stringLiterals(call);
    if (!name?.startsWith("-")) continue;
    member(
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
    if (sha256(source.lines.join("\n")) !== source.excerptSha256)
      violations.push(`${source.id}: authoritative excerpt hash changed.`);
    if (!source.version || !source.citation || source.endLine - source.startLine + 1 !== source.lines.length)
      violations.push(`${source.id}: incomplete source identity or line range.`);
  }
  const derived = new Map(deriveAuthoritativeGrammar(grammar).map((member) => [member.id, member]));
  const listed = new Set();
  for (const member of grammar.partition) {
    if (listed.has(member.id)) violations.push(`${member.id}: duplicate partition member.`);
    listed.add(member.id);
    if (!derived.has(member.id)) violations.push(`${member.id}: unsourced partition member.`);
    else if (JSON.stringify(member) !== JSON.stringify(derived.get(member.id)))
      violations.push(`${member.id}: partition differs from authoritative derivation.`);
  }
  for (const id of derived.keys()) if (!listed.has(id)) violations.push(`${id}: missing partition member.`);
  const benignIds = new Set();
  for (const entry of grammar.benignForms ?? []) {
    if (benignIds.has(entry.id)) violations.push(`${entry.id}: duplicate benign form.`);
    benignIds.add(entry.id);
    violations.push(...benignAdmissionViolations(entry, grammar));
  }
  return { passed: violations.length === 0, members: derived.size, violations };
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
const operatorAt = (run, index) => operators.find((operator) => run.startsWith(operator, index));
const blank = (character) => character === " " || character === "\t" || character === "\r" || character === "\n";

// Index of the shell delimiter closing the group opened at `start`. Escapes,
// single/double quotes and double-quoted command substitutions are skipped.
function shellGroupEnd(run, start, open = "(", close = ")") {
  let depth = 1;
  let quote = null;
  for (let index = start + 1; index < run.length; index += 1) {
    const character = run[index];
    if (character === "\\" && quote !== "'") index += 1;
    else if (quote === '"' && run.startsWith("$(", index)) index = shellGroupEnd(run, index + 1);
    else if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return run.length;
}

// Arithmetic stays data only for names/numbers joined by + or -; command
// substitutions and workflow expressions are opaque values.
function boundedArithmetic(expression) {
  let shape = "";
  for (let index = 0; index < expression.length; index += 1) {
    if (expression.startsWith("$(", index)) {
      const end = shellGroupEnd(expression, index + 1);
      if (end === expression.length) return false;
      shape += "VALUE";
      index = end;
    } else if (expression.startsWith("${{", index)) {
      const end = expression.indexOf("}}", index + 3);
      if (end < 0) return false;
      shape += "VALUE";
      index = end + 1;
    } else shape += expression[index];
  }
  return /^\s*(?:\d+#)?[A-Za-z_0-9]+(?:\s*[+-]\s*[A-Za-z_0-9]+)*\s*$/.test(shape);
}

function nestedSubstitutions(text, offset, found) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text.startsWith("$(", index)) {
      const end = shellGroupEnd(text, index + 1);
      found.push({ run: text.slice(index + 2, end), index: offset + index });
      index = end;
    } else if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end < 0) {
        found.push({ run: "'", index: offset + index });
        return;
      }
      found.push({ run: text.slice(index + 1, end), index: offset + index });
      index = end;
    }
  }
}

// Lexes one Bash run script. Words keep their expansion identity (dynamic),
// whether any quoting occurred, whether any expansion sits outside double
// quotes (unprotected: it may split) and whether an unquoted glob or brace
// expansion occurs (pattern); quoting removes syntax, never executable
// position. Here-document bodies are data except substitutions in bodies whose
// delimiter is unquoted. Every loop iteration consumes at least one character.
function shellTokens(run) {
  const tokens = [];
  const substitutions = [];
  const errors = [];
  const productions = new Set();
  const pendingDocuments = [];
  let heredocOperator = null;
  let index = 0;

  const readDocuments = () => {
    for (const document of pendingDocuments.splice(0)) {
      const bodyStart = index;
      let terminated = false;
      while (index < run.length) {
        const newline = run.indexOf("\n", index);
        const lineEnd = newline < 0 ? run.length : newline;
        let line = run.slice(index, lineEnd).replace(/\r$/, "");
        if (document.stripTabs) line = line.replace(/^\t+/, "");
        const next = newline < 0 ? run.length : newline + 1;
        if (line === document.delimiter) {
          document.token.body = run.slice(bodyStart, index);
          if (!document.quoted) nestedSubstitutions(document.token.body, bodyStart, substitutions);
          index = next;
          terminated = true;
          break;
        }
        index = next;
      }
      if (!terminated) errors.push("unterminated here-document");
    }
  };

  const readWord = () => {
    const start = index;
    let value = "";
    let quote = null;
    let quoted = false;
    let dynamic = false;
    let unprotected = false;
    let pattern = false;
    let braces = 0;
    let braceList = false;
    const expansion = () => {
      dynamic = true;
      if (!quote) unprotected = true;
    };
    while (index < run.length) {
      const character = run[index];
      if (!quote && (blank(character) || operatorAt(run, index))) break;
      if (character === "\\" && quote !== "'") {
        const next = run[index + 1];
        if (next === "\n") index += 2;
        else if (next === "\r" && run[index + 2] === "\n") index += 3;
        else if (quote === '"' && !["$", "`", '"', "\\"].includes(next)) {
          value += character;
          index += 1;
        } else {
          value += next ?? "";
          index += 2;
        }
        continue;
      }
      if ((character === "'" || character === '"') && (!quote || quote === character)) {
        quote = quote ? null : character;
        quoted = true;
        index += 1;
        continue;
      }
      if (quote !== "'" && run.startsWith("$((", index)) {
        const end = shellGroupEnd(run, index + 2);
        if (run[end + 1] === ")") {
          productions.add("arith_command");
          if (!boundedArithmetic(run.slice(index + 3, end))) errors.push("unlisted arithmetic form");
          nestedSubstitutions(run.slice(index + 3, end), index + 3, substitutions);
          value += run.slice(index, end + 2);
          expansion();
          index = end + 2;
          continue;
        }
      }
      if (quote !== "'" && run.startsWith("$(", index)) {
        const end = shellGroupEnd(run, index + 1);
        if (end === run.length) errors.push("unterminated command substitution");
        substitutions.push({ run: run.slice(index + 2, end), index });
        productions.add("comsub");
        value += run.slice(index, end + 1);
        expansion();
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
        expansion();
        index = end + 1;
        continue;
      }
      if (quote !== "'" && run.startsWith("${", index)) {
        const end = shellGroupEnd(run, index + 1, "{", "}");
        if (end === run.length) errors.push("unterminated parameter expansion");
        const inner = run.slice(index + 2, end);
        if (/^[\s|]/.test(inner)) errors.push("unsupported function substitution");
        nestedSubstitutions(inner, index + 2, substitutions);
        value += run.slice(index, end + 1);
        expansion();
        index = end + 1;
        continue;
      }
      if (quote !== "'" && character === "$") expansion();
      if (!quote && "*?[".includes(character)) pattern = true;
      if (!quote && character === "{") braces += 1;
      if (!quote && braces && (character === "," || run.startsWith("..", index))) braceList = true;
      if (!quote && braces && character === "}") {
        braces -= 1;
        if (braceList) pattern = true;
      }
      value += character;
      index += 1;
    }
    if (quote) errors.push("unterminated quoted word");
    const raw = run.slice(start, index);
    const token = { type: "word", value, dynamic, quoted, unprotected, pattern, index: start, raw };
    tokens.push(token);
    if (heredocOperator) {
      pendingDocuments.push({ delimiter: value, quoted, stripTabs: heredocOperator === "<<-", token });
      heredocOperator = null;
    }
  };

  while (index < run.length) {
    const character = run[index];
    if (character === "\\" && (run[index + 1] === "\n" || run[index + 1] === "\r")) {
      index += run[index + 1] === "\r" ? 3 : 2;
    } else if (character === " " || character === "\t" || character === "\r") {
      index += 1;
    } else if (character === "#") {
      const newline = run.indexOf("\n", index);
      index = newline < 0 ? run.length : newline;
    } else if (run.startsWith("((", index)) {
      const end = shellGroupEnd(run, index + 1);
      if (run[end + 1] === ")") {
        productions.add(tokens.at(-1)?.value === "for" ? "arith_for_command" : "arith_command");
        if (!boundedArithmetic(run.slice(index + 2, end))) errors.push("unlisted arithmetic form");
        nestedSubstitutions(run.slice(index + 2, end), index + 2, substitutions);
        tokens.push({ type: "operator", value: "\n", index });
        index = end + 2;
      } else {
        tokens.push({ type: "operator", value: "(", index });
        index += 1;
      }
    } else if (run.startsWith("<(", index) || run.startsWith(">(", index)) {
      const end = shellGroupEnd(run, index + 1);
      const raw = run.slice(index, end + 1);
      substitutions.push({ run: run.slice(index + 2, end), index });
      tokens.push({
        type: "word",
        value: raw,
        dynamic: true,
        quoted: false,
        unprotected: true,
        pattern: false,
        index,
        raw,
      });
      index = end + 1;
    } else {
      const operator = operatorAt(run, index);
      if (!operator) {
        readWord();
        continue;
      }
      tokens.push({ type: "operator", value: operator, index });
      index += operator.length;
      if (operator === "<<" || operator === "<<-") heredocOperator = operator;
      if (operator === "\n") readDocuments();
    }
  }
  if (heredocOperator || pendingDocuments.length) errors.push("unterminated here-document");
  return { tokens, substitutions, errors, productions };
}

const assignmentWord = (value) => /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(value ?? "");
const emptyAssignment = (value) => assignmentWord(value) && value.endsWith("=");
const reservedCommandWords = new Set([
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "{",
  "}",
  "fi",
  "done",
  "esac",
]);

// Simple commands in token order. Case patterns, for headers and array bodies
// are data; leading assignments are separated from words; redirections keep
// their target token.
function commandsFromTokens(tokens) {
  const commands = [];
  let current = { words: [], redirects: [], assignments: [] };
  let header = null;
  let inPattern = false;
  let caseDepth = 0;
  let arrayDepth = 0;
  const flush = () => {
    if (current.words.length || current.assignments.length) commands.push(current);
    current = { words: [], redirects: [], assignments: [] };
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const { value } = token;
    const { words } = current;
    if (header) {
      if (header === "case" && value === "in") {
        header = null;
        inPattern = true;
      } else if (header === "for" && value === "do") header = null;
      continue;
    }
    if (inPattern) {
      if (value === ")") inPattern = false;
      else if (value === "esac") {
        inPattern = false;
        caseDepth -= 1;
      }
      continue;
    }
    if (arrayDepth) {
      if (value === "(") arrayDepth += 1;
      else if (value === ")") arrayDepth -= 1;
      continue;
    }
    if (token.type === "operator" && redirections.has(value)) {
      const last = words.at(-1);
      if (last && /^(?:\d+|\{[A-Za-z_]\w*\})$/.test(last.value) && last.index + last.raw.length === token.index)
        words.pop();
      index += 1;
      current.redirects.push({ operator: value, target: tokens[index] });
      continue;
    }
    if (token.type === "operator") {
      if (value === "(" && emptyAssignment(words.at(-1)?.value)) {
        words.pop();
        arrayDepth = 1;
      } else if (value === "(" && tokens[index + 1]?.value === ")") {
        current.words = [];
        index += 1;
      } else {
        flush();
        if ([";;", ";&", ";;&"].includes(value) && caseDepth) inPattern = true;
      }
      continue;
    }
    if (!words.length && assignmentWord(token.raw)) {
      const separator = value.indexOf("=");
      const assignment = { name: value.slice(0, separator), value: value.slice(separator + 1), token };
      if (emptyAssignment(value) && tokens[index + 1]?.value === "(") {
        const end = tokens.findIndex((candidate, position) => position > index + 1 && candidate.value === ")");
        const body = tokens.slice(index + 2, end);
        assignment.invalidArray =
          end < 0 ||
          assignment.name.includes("[") ||
          body.some((candidate) => candidate.type === "operator" && candidate.value !== "\n");
        assignment.array = body.filter((candidate) => candidate.type === "word");
        arrayDepth = 1;
        index += 1;
      }
      current.assignments.push(assignment);
      continue;
    }
    if (!words.length && !token.quoted) {
      if (value === "case") {
        header = "case";
        caseDepth += 1;
        continue;
      }
      if (value === "for") {
        header = "for";
        continue;
      }
      if (value === "function") {
        index += 1;
        continue;
      }
      if (reservedCommandWords.has(value)) {
        if (value === "esac") caseDepth = Math.max(0, caseDepth - 1);
        continue;
      }
      if (assignmentWord(value)) continue;
    }
    words.push(token);
  }
  flush();
  return commands;
}

function handledForms(grammar, surface) {
  return grammar.partition
    .filter((member) => member.surface === surface && member.disposition === "HANDLED")
    .map((member) => member.form);
}

function consumeOptions(words, start, options) {
  const used = [];
  let index = start;
  for (; index < words.length && words[index].value.startsWith("-"); index += 1) {
    const { value } = words[index];
    if (value === "-") return { index, used };
    if (value === "--") return { index: index + 1, used };
    const [name, ...inline] = value.split("=");
    let option = options.find((candidate) => candidate.names.includes(name));
    if (!option && name.startsWith("--no-")) {
      const positive = name.replace("--no-", "--");
      option = options.find((candidate) => candidate.arity === 0 && candidate.names.includes(positive));
    }
    if (!option) {
      const attached = options.find(
        (candidate) =>
          candidate.arity === 1 &&
          candidate.names.some((alias) => alias.length === 2 && value.length > 2 && value.startsWith(alias)),
      );
      if (!attached) return { index, reason: `unlisted option ${name}` };
      used.push(attached.names.find((alias) => alias.length === 2 && value.startsWith(alias)));
      continue;
    }
    used.push(name);
    if (option.arity === "equals" && !inline.join("=")) return { index, reason: `${name} requires =value` };
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

// A literal word, or a quoted "$VAR/fixed/path" whose basename is fixed.
function fixedSelector(word) {
  if (!word?.dynamic) return word?.value ?? null;
  if (!word.quoted || /\$\(|`|\$\{\{/.test(word.raw)) return null;
  return /^(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\})\/[A-Za-z0-9_./-]+$/.test(word.value) ? basename(word.value) : null;
}

const ambiguousAssignmentContext =
  /^(?:if|then|elif|else|for|while|until|select|case|function|eval|source|\.|read|mapfile|declare|local|export|unset)$/;
const dataOnlyBetweenAssignment = new Set(["curl", "echo", "chmod", "sha256sum", "true"]);

// The single same-step plain assignment that must reach `command` unchanged:
// no control flow, grouping, rebinding builtin or unlisted intervening command.
function dominatingAssignment(name, command, commands, tokens) {
  const position = command.words[0]?.index ?? 0;
  const writes = commands.flatMap((item) =>
    item.assignments
      .filter((assignment) => assignment.token.index < position && assignment.name.replace(/\+|\[.*\]/g, "") === name)
      .map((assignment) => ({ ...assignment, owner: item })),
  );
  const assignment = writes.at(-1);
  if (!assignment || assignment.name !== name || assignment.owner.words.length) return null;
  const at = assignment.token.index;
  const before = tokens.filter((token) => token.index < at);
  const between = tokens.filter((token) => token.index > at && token.index < position);
  const unquotedIn = (list, test) => list.some((token) => !token.quoted && test(token.value));
  if (unquotedIn([...before, ...between], (value) => ambiguousAssignmentContext.test(value))) return null;
  if (unquotedIn(before, (value) => ["(", ")", "{", "}", "&&", "||"].includes(value))) return null;
  const intervening = commands.filter((item) => item.words[0]?.index > at && item.words[0].index < position);
  const reproducedVersionProbe = (item) =>
    assignment.value === "${RUNNER_TEMP}/kubectl-argo-rollouts" &&
    item.words[0].raw === '"$binary"' &&
    item.words.length === 2 &&
    ["version", "--help"].includes(item.words[1].value);
  if (intervening.some((item) => !dataOnlyBetweenAssignment.has(item.words[0].value) && !reproducedVersionProbe(item)))
    return null;
  if (!assignment.array && unquotedIn(between, (value) => ["(", ")", "{", "}"].includes(value))) return null;
  return assignment;
}

function resolveCommandWords(command, commands, tokens) {
  let { words } = command;
  const variable = words[0]?.raw.match(/^"\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))"$/);
  if (variable) {
    const assignment = dominatingAssignment(variable[1] ?? variable[2], command, commands, tokens);
    if (assignment && !assignment.array) {
      const raw = assignment.token.raw.slice(assignment.token.raw.indexOf("=") + 1);
      const selector = fixedSelector({ ...assignment.token, value: assignment.value, raw });
      if (selector)
        words = [{ ...words[0], value: selector, dynamic: false, quoted: false, raw: selector }, ...words.slice(1)];
    }
  }
  // The finite corpus forwards one script through a same-step literal array.
  if (words[0]?.value === "pnpm" && words[1]?.value === "run" && words[2]?.raw === '"${args[@]}"') {
    const assignment = dominatingAssignment("args", command, commands, tokens);
    if (assignment?.array?.[0] && !assignment.array[0].dynamic)
      words = [...words.slice(0, 2), ...assignment.array, ...words.slice(3)];
  }
  return { ...command, words };
}

const blockOpeners = {
  if: ["fi", "if_command"],
  case: ["esac", "case_command"],
  for: ["done", "for_command"],
  while: ["done", "shell_command"],
  until: ["done", "shell_command"],
  "{": ["}", "group_command"],
};

function shellSyntaxErrors(tokens, commands, grammar) {
  const errors = [];
  const closers = [];
  const bodies = [];
  const data = new Set(
    commands.flatMap((command) => [
      ...command.words.slice(1),
      ...command.redirects.map(({ target }) => target),
      ...command.assignments.flatMap((assignment) => [assignment.token, ...(assignment.array ?? [])]),
    ]),
  );
  const encounter = (production) => {
    const handled = grammar.partition.some(
      (member) =>
        member.surface === "shell" && member.form.production === production && member.disposition === "HANDLED",
    );
    if (!handled) errors.push(`INDETERMINATE shell production ${production}`);
  };
  const significantBefore = (index) => tokens.slice(0, index).findLast((token) => token.value !== "\n");
  const significantAfter = (index) => tokens.slice(index + 1).find((token) => token.value !== "\n");
  for (const [index, token] of tokens.entries()) {
    if (data.has(token) || token.quoted) continue;
    const { value } = token;
    const operator = token.type === "operator";
    if (operator && redirections.has(value)) {
      encounter("redirection");
      if (tokens[index + 1]?.type !== "word") errors.push("missing redirection operand");
    } else if (operator && ["&&", "||", "|", "|&"].includes(value)) {
      const previous = significantBefore(index);
      const next = significantAfter(index);
      if (
        !previous ||
        !next ||
        (previous.type === "operator" && previous.value !== ")") ||
        (next.type === "operator" && next.value !== "(") ||
        ["fi", "done", "esac", "then", "else"].includes(next.value)
      )
        errors.push(`missing command around ${value}`);
    } else if (operator && value === "(") {
      closers.push(")");
      bodies.push(true);
      encounter("subshell");
    } else if (operator && value === ")") {
      if (closers.at(-1) === ")") {
        closers.pop();
        bodies.pop();
      } else if (closers.at(-1) !== "esac") errors.push("unmatched closing parenthesis");
    } else if (Object.hasOwn(blockOpeners, value)) {
      closers.push(blockOpeners[value][0]);
      bodies.push(value === "{");
      encounter(blockOpeners[value][1]);
    } else if (["fi", "done", "esac", "}"].includes(value)) {
      if (closers.pop() !== value) errors.push(`unmatched ${value}`);
      if (!bodies.pop()) errors.push(`missing body delimiter before ${value}`);
    } else if (value === "elif") {
      encounter("elif_clause");
      if (closers.at(-1) !== "fi" || !bodies.at(-1)) errors.push("unmatched elif");
      bodies[bodies.length - 1] = false;
    } else if (value === "then" || value === "else") {
      const state = bodies.at(-1);
      if (closers.at(-1) !== "fi" || (value === "then" && state) || (value === "else" && (!state || state === "else")))
        errors.push(`unmatched ${value}`);
      else bodies[bodies.length - 1] = value;
    } else if (value === "do") {
      if (closers.at(-1) !== "done" || bodies.at(-1)) errors.push("unmatched do");
      else bodies[bodies.length - 1] = true;
    } else if (value === "in" && closers.at(-1) === "esac") bodies[bodies.length - 1] = true;
    else if ([";;", ";&", ";;&"].includes(value) && closers.at(-1) !== "esac")
      errors.push("case terminator outside case");
    else if (["select", "coproc", "time"].includes(value)) errors.push(`unsupported ${value} production`);
  }
  if (closers.length) errors.push(`unterminated shell group (${closers.join(", ")})`);
  for (const command of commands) {
    encounter("simple_command");
    if (command.assignments.some((assignment) => assignment.invalidArray))
      errors.push("unlisted array assignment form");
    if (command.words[0]?.value === "[[") {
      encounter("cond_command");
      if (command.words.at(-1)?.value !== "]]") errors.push("unterminated conditional command");
    }
  }
  return [...new Set(errors)];
}

// ---------------------------------------------------------------------------
// Benign-form admission. validateGrammarPartition proves each stored entry
// (benignAdmissionViolations); benignFormMatch re-proves the roles of every
// match over the actual tokens and run context (roleViolations). A command is
// admitted only when both return no violation.

const dataOperandSelectors = new Set(["echo", "printf", "[", "[[", "test", "mkdir", "cp", "chmod", "install", "cat"]);
const shellInterpreters = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const coveredToken = new RegExp(
  `(?:^|[^A-Za-z0-9_.-])(?:${["terraform", "doctl", ...[...scriptOperations.keys()].map((key) => key.replaceAll(".", "\\."))].join("|")})(?=$|[^A-Za-z0-9_-])`,
);
const unquoted = (text) => text.replace(/["'\\]/g, "");
const containsCoveredToken = (text) => coveredToken.test(text) || coveredToken.test(unquoted(text));

const literal = (word, value) => Boolean(word) && !word.dynamic && word.value === value;
const literalOption = (word) => Boolean(word) && !word.dynamic && word.value.length > 1 && word.value.startsWith("-");
// Lexed words carry raw-derived quote facts. Stored entry words have only the
// quoted flag, so validation reads that flag and the classifier re-proves each
// match against the actual tokens.
const unprotectedExpansion = (word) => word.dynamic && (word.unprotected ?? !word.quoted);
const filenamePattern = (word) => word.pattern ?? (!word.quoted && /[*?[]|\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(word.value));
// Words whose expansion may yield any number of arguments.
const variadicWord = (word) =>
  filenamePattern(word) ||
  (word.dynamic && (unprotectedExpansion(word) || /\$\{?[@*]\}?|\$\{[A-Za-z_]\w*\[[@*]\]\}/.test(word.value)));
// One argument of any runtime content: a pinned spelling or one protected expansion.
const singleArgument = (word) => Boolean(word) && !variadicWord(word);
// A fixed program text, or a fixed non-option script/package/program name.
const pinnedText = (word) => Boolean(word) && !word.dynamic && !filenamePattern(word);
const pinnedOperand = (word) => pinnedText(word) && !word.value.startsWith("-");

// The executable a hop selects, after resolving a literal path or a fully
// quoted "$VAR/fixed/basename" spelling. Dynamic, partially quoted, pattern and
// option-shaped selectors resolve to nothing.
function hopSelector(word) {
  if (!word || filenamePattern(word) || unprotectedExpansion(word)) return null;
  const selector = fixedSelector({ ...word, raw: word.raw ?? word.value });
  return selector && !selector.startsWith("-") ? basename(selector) : null;
}

function spaced(list) {
  return new Set(list.split(" ").filter(Boolean));
}

// Option tables list spellings: `-x` is a flag, `--x=` takes an inline value
// and `--x:N` takes N following values; one name may list several spellings.
function optionTable(list) {
  const table = new Map();
  for (const spelling of spaced(list)) {
    const [, name, inline, values] = spelling.match(/^(.+?)(=)?(?::(\d))?$/);
    const option = table.get(name) ?? { flag: false, inline: false, values: 0 };
    if (inline) option.inline = true;
    else if (values) option.values = Number(values);
    else option.flag = true;
    table.set(name, option);
  }
  return table;
}

// The index after the option at `index` and its single-argument values, or -1
// when the table does not prove that option in that spelling.
function optionEnd(words, index, table) {
  const word = words[index];
  const separator = word.value.indexOf("=");
  const name = separator < 0 ? word.value : word.value.slice(0, separator);
  const option = table.get(name);
  if (!option || name.includes("$") || !singleArgument(word)) return -1;
  if (separator >= 0) return option.inline ? index + 1 : -1;
  if (word.dynamic) return -1;
  if (option.flag) return index + 1;
  const values = words.slice(index + 1, index + 1 + option.values);
  return option.values && values.length === option.values && values.every(singleArgument)
    ? index + 1 + option.values
    : -1;
}

// A non-forwarding utility with finite, origin-proved command shapes. `shapes`
// maps each literal command path ("" when none) to its option table, or to
// { options, operands, variadic }: `operands` bounds the non-option data
// words and `variadic` proves multi-argument expansions to be data. `global`
// options precede the path. A literal `--` that a shape lists ends the checks.
function terminal({ global = "", shapes = { "": "" } } = {}) {
  const globals = optionTable(global);
  const table = Object.entries(shapes).map(([path, shape]) => {
    const {
      options = "",
      operands = Infinity,
      variadic = false,
    } = typeof shape === "string" ? { options: shape } : shape;
    return { path: path ? path.split(" ") : [], options: optionTable(options), operands, variadic };
  });
  const admit = (words, at) => {
    let index = at + 1;
    while (literalOption(words[index]) && globals.has(words[index].value.split("=")[0])) {
      index = optionEnd(words, index, globals);
      if (index < 0) return false;
    }
    const shape = table
      .filter(({ path }) => path.every((part, offset) => literal(words[index + offset], part)))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!shape) return false;
    let operands = 0;
    for (index += shape.path.length; index < words.length; ) {
      const word = words[index];
      if (literal(word, "--") && shape.options.has("--")) return true;
      if (word.value.startsWith("-") && word.value !== "-") {
        index = optionEnd(words, index, shape.options);
        if (index < 0) return false;
      } else {
        if (variadicWord(word) ? !shape.variadic : ++operands > shape.operands) return false;
        index += 1;
      }
    }
    return true;
  };
  return Object.assign(admit, { global: globals, shapes: table });
}

// Prefix commands. Each one requires a further executable and redispatches it.
function timeoutPrefix(words, at, next) {
  const duration = words[at + 1];
  return Boolean(duration) && !duration.dynamic && /^\d+(?:\.\d+)?[smhd]?$/.test(duration.value) && next(at + 2);
}

function envPrefix(words, at, next) {
  let index = at + 1;
  while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value) && singleArgument(words[index]))
    index += 1;
  if (literal(words[index], "--")) index += 1;
  return next(index);
}

function execPrefix(words, at, next) {
  return next(literal(words[at + 1], "--") ? at + 2 : at + 1);
}

function commandPrefix(words, at, next) {
  let index = at + 1;
  if (literal(words[index], "-v")) return words.length === index + 2 && pinnedOperand(words[index + 1]);
  if (literal(words[index], "-p")) index += 1;
  if (literal(words[index], "--")) index += 1;
  return next(index);
}

// Origin-proved dynamic package selection. These are the complete boot_smoke
// run blocks at 926050f8 (YAML-decoded, LF), the only corpus commands whose
// pnpm --filter package is dynamic. originWitness re-proves from each text that
// `workspace="$2"` is its only binding, that nothing rebinds the positional
// parameters, and that boot_smoke has exactly two callers, each passing a
// literal package; "$workspace" therefore selects one of those packages only
// inside that exact text and substitution occurrence.
const bootSmokeBlocks = [
  {
    origin: {
      sha: "926050f88aae70a631c117c1e0f002a3160a9278",
      path: ".github/workflows/platform-pr.yml",
      job: "docker-image",
      step: 7,
    },
    run: [
      "set -euo pipefail",
      "",
      "# Keep this aligned with Build Release Image boot smoke in",
      "# platform-production.yml: start each web component exactly as App",
      "# Platform does (run_command and health_check from",
      "# infrastructure/digitalocean/platform/main.tf) before the merge",
      "# queue accepts a Docker image change.",
      "boot_smoke() {",
      '  component="$1"',
      '  workspace="$2"',
      '  health_path="$3"',
      '  host_port="$4"',
      "",
      '  container_id="$(docker run -d \\',
      "    -e NODE_ENV=production \\",
      "    -e PORT=8080 \\",
      '    -p "${host_port}:8080" \\',
      '    "$PLATFORM_IMAGE" \\',
      '    pnpm --filter "$workspace" run start)"',
      "",
      "  for _ in $(seq 1 30); do",
      '    if curl --fail --silent --output /dev/null "http://localhost:${host_port}${health_path}"; then',
      '      if [ "$component" = "public-web" ] && ! pnpm run smoke:public-web-routes -- \\',
      '        --base-url "http://localhost:${host_port}" \\',
      "        --mode no-5xx; then",
      '        echo "Boot smoke failed for public-web: the derived public route walk was not 5xx-free." >&2',
      '        docker logs "$container_id" >&2 || true',
      '        docker rm -f "$container_id" >/dev/null || true',
      "        return 1",
      "      fi",
      '      echo "Boot smoke passed for ${component} (${health_path})."',
      '      docker rm -f "$container_id" >/dev/null',
      "      return 0",
      "    fi",
      '    if [ "$(docker inspect --format \'{{.State.Running}}\' "$container_id")" != "true" ]; then',
      "      break",
      "    fi",
      "    sleep 1",
      "  done",
      "",
      '  echo "Boot smoke failed for ${component}: ${health_path} never became healthy." >&2',
      '  docker logs "$container_id" >&2 || true',
      '  docker rm -f "$container_id" >/dev/null || true',
      "  return 1",
      "}",
      "",
      'boot_smoke marketplace "@chase-sets/app-marketplace-web" /health/ready 18080',
      'boot_smoke public-web "@chase-sets/app-public-web" / 18081',
      "",
    ].join("\n"),
  },
  {
    origin: {
      sha: "926050f88aae70a631c117c1e0f002a3160a9278",
      path: ".github/workflows/platform-production.yml",
      job: "build-image",
      step: 7,
    },
    run: [
      "set -euo pipefail",
      "",
      "# Build-time success does not prove runtime success (issue #1417):",
      "# start each web component with its deployed command and health check",
      "# so a non-booting image fails this parallel job before the push and",
      "# never reaches the deploy lane.",
      "boot_smoke() {",
      '  component="$1"',
      '  workspace="$2"',
      '  health_path="$3"',
      '  host_port="$4"',
      "",
      '  container_id="$(docker run -d \\',
      "    -e NODE_ENV=production \\",
      "    -e PORT=8080 \\",
      '    -p "${host_port}:8080" \\',
      '    "$RELEASE_IMAGE" \\',
      '    pnpm --filter "$workspace" run start)"',
      "",
      "  for _ in $(seq 1 30); do",
      '    if curl --fail --silent --output /dev/null "http://localhost:${host_port}${health_path}"; then',
      '      if [ "$component" = "public-web" ] && ! pnpm run smoke:public-web-routes -- \\',
      '        --base-url "http://localhost:${host_port}" \\',
      "        --mode no-5xx; then",
      '        echo "Boot smoke failed for public-web: the derived public route walk was not 5xx-free." >&2',
      '        docker logs "$container_id" >&2 || true',
      '        docker rm -f "$container_id" >/dev/null || true',
      "        return 1",
      "      fi",
      '      echo "Boot smoke passed for ${component} (${health_path})."',
      '      docker rm -f "$container_id" >/dev/null',
      "      return 0",
      "    fi",
      '    if [ "$(docker inspect --format \'{{.State.Running}}\' "$container_id")" != "true" ]; then',
      "      break",
      "    fi",
      "    sleep 1",
      "  done",
      "",
      '  echo "Boot smoke failed for ${component}: ${health_path} never became healthy." >&2',
      '  docker logs "$container_id" >&2 || true',
      '  docker rm -f "$container_id" >/dev/null || true',
      "  return 1",
      "}",
      "",
      'boot_smoke marketplace "@chase-sets/app-marketplace-web" /health/ready 18080',
      'boot_smoke public-web "@chase-sets/app-public-web" / 18081',
      "",
    ].join("\n"),
  },
];

const rebindingCommands = new Set(["shift", "read", "unset", "local", "declare", "typeset", "readonly", "export"]);

function originWitness({ origin, run }) {
  const { tokens, substitutions, errors } = shellTokens(run);
  const commands = commandsFromTokens(tokens);
  const definitions = tokens.filter(
    (token, index) =>
      token.value === "boot_smoke" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.value === ")",
  );
  const bindings = commands.flatMap((command) => command.assignments).filter(({ name }) => name === "workspace");
  const rebinding = commands.some(
    ({ words }) =>
      rebindingCommands.has(words[0]?.value) ||
      (words[0]?.value === "set" &&
        words.slice(1).some((word) => !literal(word, "-euo") && !literal(word, "pipefail"))),
  );
  const callers = commands.filter(({ words }) => words[0]?.value === "boot_smoke");
  const occurrences = substitutions.flatMap((substitution) =>
    commandsFromTokens(shellTokens(substitution.run).tokens)
      .filter(({ words }) => words.some((word) => word.raw === '"$workspace"'))
      .map((command) => ({ substitution, command })),
  );
  const [binding] = bindings;
  const [{ substitution, command } = {}] = occurrences;
  const proved =
    !errors.length &&
    definitions.length === 1 &&
    bindings.length === 1 &&
    binding.token.raw === 'workspace="$2"' &&
    !tokens.some((token) => token.type === "word" && token.value === "workspace") &&
    !rebinding &&
    callers.length === 2 &&
    callers.every(({ words }) => words.length === 5 && pinnedOperand(words[2])) &&
    new Set(callers.map(({ words }) => words[2].value)).size === 2 &&
    occurrences.length === 1 &&
    definitions[0].index < binding.token.index &&
    binding.token.index < substitution.index &&
    callers.every(({ words }) => substitution.index < words[0].index);
  return proved ? { origin, run, occurrence: substitution.index, words: command.words } : null;
}

const originWitnesses = bootSmokeBlocks.map(originWitness).filter(Boolean);

// A stored entry is bound to a witness only when its origin names that block
// and its words are exactly the block's occurrence command.
function entryOriginWitness(entry) {
  const witness = originWitnesses.find(({ origin }) =>
    ["sha", "path", "job", "step"].every((field) => origin[field] === entry.origin?.[field]),
  );
  const exact =
    witness &&
    entry.input === undefined &&
    entry.words.length === witness.words.length &&
    entry.words.every(
      (word, index) =>
        word.value === witness.words[index].value &&
        word.dynamic === witness.words[index].dynamic &&
        word.quoted === witness.words[index].quoted,
    );
  return exact ? witness : null;
}

// The witness whose complete run block this run is, CRLF normalized.
function runOriginWitness(run) {
  const normalized = run.replaceAll("\r\n", "\n");
  return originWitnesses.find((witness) => witness.run === normalized) ?? null;
}

// pnpm roles: exec/dlx select an executable; run, --filter run and the corpus
// --filter test alias select a pinned package script whose arguments are data.
// A dynamic package is only "$workspace" in its origin-proved occurrence.
function pnpmRoles(words, at, next, context) {
  const role = words[at + 1];
  if (literal(role, "exec") || literal(role, "dlx")) return next(at + 2);
  if (literal(role, "run")) return pinnedOperand(words[at + 2]);
  if (literal(role, "install")) return words.length === at + 3 && literal(words[at + 2], "--frozen-lockfile");
  if (literal(role, "--filter")) {
    const workspace = words[at + 2];
    const originPackage =
      context.origin !== null && workspace?.value === "$workspace" && workspace.dynamic && singleArgument(workspace);
    if (!pinnedOperand(workspace) && !originPackage) return false;
    if (literal(words[at + 3], "run")) return pinnedOperand(words[at + 4]);
    return literal(words[at + 3], "test");
  }
  return false;
}

// find: one origin-proved start path, then exactly `-type f -name <pattern>`
// with an optional `! -name <pattern>`; no action or other predicate.
function findRoles(words, at) {
  const start = words[at + 1];
  // Origin: EVIDENCE_DIR is the workflow's fixed artifacts/wake-drills path.
  const originEvidenceDirectory =
    Boolean(start) && start.dynamic && start.value === "$EVIDENCE_DIR" && singleArgument(start);
  if (!pinnedOperand(start) && !originEvidenceDirectory) return false;
  const head = literal(words[at + 2], "-type") && literal(words[at + 3], "f") && literal(words[at + 4], "-name");
  if (!head || !pinnedText(words[at + 5])) return false;
  if (words.length === at + 6) return true;
  return (
    words.length === at + 9 &&
    literal(words[at + 6], "!") &&
    literal(words[at + 7], "-name") &&
    pinnedText(words[at + 8])
  );
}

// Interpreter modes: a pinned program after its program flag, non-empty pinned
// stdin after `-`, a pinned script, or an exact query. Python ends option
// parsing at `-c` and `-`; the other program flags keep parsing options, so
// their program must end the command. Words after a script or stdin are that
// program's single-argument argv.
const interpreterModes = {
  python: { program: "-c", argv: true, stdin: true },
  python3: { program: "-c", argv: true, stdin: true },
  perl: { program: "-e", stdin: true },
  ruby: { program: "-e", stdin: true },
  pwsh: { program: "-c" },
  node: { program: "-e", stdin: true, query: "--version" },
};

function interpreterRoles(words, at, next, context) {
  const mode = interpreterModes[hopSelector(words[at])];
  const first = words[at + 1];
  const argv = (start) => words.slice(start).every(singleArgument);
  if (literal(first, mode.program))
    return pinnedText(words[at + 2]) && (mode.argv ? argv(at + 3) : words.length === at + 3);
  if (literal(first, "-"))
    return (
      Boolean(mode.stdin) &&
      Array.isArray(context.input) &&
      context.input.some((document) => typeof document === "string" && document.trim()) &&
      argv(at + 2)
    );
  if (mode.query && literal(first, mode.query)) return words.length === at + 2;
  return pinnedOperand(first) && argv(at + 2);
}

const shellProgram = (words, at) =>
  literal(words[at + 1], "-c") && pinnedText(words[at + 2]) && words.length === at + 3;
const evalProgram = (words, at) => words.length === at + 2 && pinnedText(words[at + 1]);

// psql -c text is sent to the server unless it begins with a backslash
// meta-command; a dynamic text must pin a literal SQL lead.
function psqlRoles(words, at) {
  const valued = spaced("-U -d -v -c -tAc");
  for (let index = at + 1; index < words.length; index += 2) {
    const option = words[index];
    const value = words[index + 1];
    if (!literalOption(option) || !valued.has(option.value) || !singleArgument(value)) return false;
    if (
      ["-c", "-tAc"].includes(option.value) &&
      (value.value.startsWith("\\") || (value.dynamic && /^[$`\\]/.test(value.value)))
    )
      return false;
  }
  return true;
}

const pinnedImages = new Map([
  ["alpine/helm:3.15.4", "helm"],
  ["ghcr.io/yannh/kubeconform:v0.6.7", "kubeconform"],
]);
const dockerRunValued = spaced("-v -w -e -p");
const dockerRunFlags = spaced("--rm -d");

// docker exec/run reach a container program: exec names a container resource
// and redispatches its argv; run pins an image whose entrypoint has a rule, or
// redispatches the argv after a resource image.
function dockerRoles(words, at, next, context) {
  if (literal(words[at + 1], "exec")) {
    const container = words[at + 2];
    if (!singleArgument(container) || (!container.dynamic && container.value.startsWith("-"))) return false;
    return next(at + 3);
  }
  if (literal(words[at + 1], "run")) {
    let index = at + 2;
    while (literalOption(words[index])) {
      if (dockerRunFlags.has(words[index].value)) index += 1;
      else if (dockerRunValued.has(words[index].value) && singleArgument(words[index + 1])) index += 2;
      else return false;
    }
    const image = words[index];
    if (!singleArgument(image) || (!image.dynamic && image.value.startsWith("-"))) return false;
    const entrypoint = image.dynamic ? null : pinnedImages.get(image.value);
    if (!entrypoint) return next(index + 1);
    const argv = [{ value: entrypoint, dynamic: false, quoted: false }, ...words.slice(index + 1)];
    return programRules.get(entrypoint)(argv, 0, () => false, context);
  }
  // compose is its own command path: `-f <file>` precedes the pinned subcommand.
  if (literal(words[at + 1], "compose")) return composeTerminal(words, at + 1);
  return dockerTerminal(words, at);
}

const dockerTerminal = terminal({
  shapes: {
    "buildx build": "--pull --cache-from:1 --cache-to:1 --load --push --tag:1",
    "buildx imagetools create": "--tag:1",
    "buildx imagetools inspect": "--format:1 --raw",
    inspect: "--format:1",
    logs: "",
    push: "",
    restart: "",
    rm: "-f",
    tag: "",
  },
});
const composeTerminal = terminal({
  global: "-f:1",
  shapes: {
    up: { options: "--detach --wait --wait-timeout:1", operands: 0 },
    down: { options: "--volumes --remove-orphans", operands: 0 },
    logs: { options: "--no-color", operands: 0 },
    ps: { operands: 0 },
  },
});

const kubectlTerminal = terminal({
  global: "-n:1",
  shapes: {
    annotate: "-n:1",
    apply: { options: "--server-side --force-conflicts -f:1 -n:1", operands: 0 },
    "config current-context": { operands: 0 },
    "config get-contexts": { operands: 0 },
    cp: "--namespace:1 --container:1",
    create: { options: "-f:1", operands: 0 },
    "create namespace": { options: "--dry-run= -o:1", operands: 1 },
    delete: "-n:1 -l:1 --cascade= --wait= --timeout= --ignore-not-found --ignore-not-found=",
    describe: "-n:1",
    get: "-n:1 --namespace:1 -o:1 --output:1 -l:1 --selector:1 --field-selector= --sort-by= --all-namespaces --request-timeout= --ignore-not-found --ignore-not-found=",
    label: "",
    logs: "-n:1 --all-containers",
    "port-forward": "--namespace:1",
    "rollout status": "--timeout=",
    "top pods": { options: "--namespace:1 --no-headers", operands: 0 },
    wait: "-n:1 --namespace:1 --for:1 --for= --timeout= --all",
  },
});

// kubectl exec and create job forward the argv after `--` into a pod.
function kubectlRoles(words, at, next) {
  const remoteAfterSeparator = (index, valued) => {
    while (index < words.length && !literal(words[index], "--")) {
      const word = words[index];
      const name = word.value.split("=")[0];
      if (word.value.startsWith("-") && !name.includes("$") && valued.has(name) && singleArgument(word)) {
        if (word.value.includes("=")) index += 1;
        else if (singleArgument(words[index + 1]) && !literal(words[index + 1], "--")) index += 2;
        else return { index };
        continue;
      }
      return { resource: word, index };
    }
    return { index };
  };
  if (literal(words[at + 1], "exec")) {
    const { resource, index } = remoteAfterSeparator(at + 2, spaced("--namespace --container"));
    if (!singleArgument(resource) || (!resource.dynamic && resource.value.startsWith("-"))) return false;
    return literal(words[index + 1], "--") && next(index + 2);
  }
  if (literal(words[at + 1], "create") && literal(words[at + 2], "job")) {
    if (!pinnedOperand(words[at + 3])) return false;
    let index = at + 4;
    const valued = spaced("-n --image");
    while (index < words.length && !literal(words[index], "--")) {
      const word = words[index];
      const name = word.value.split("=")[0];
      if (!word.value.startsWith("-") || name.includes("$") || !valued.has(name) || !singleArgument(word)) return false;
      if (word.value.includes("=")) index += 1;
      else if (singleArgument(words[index + 1]) && !literal(words[index + 1], "--")) index += 2;
      else return false;
    }
    return literal(words[index], "--") && next(index + 1);
  }
  return kubectlTerminal(words, at);
}

function trapRoles(words, at) {
  if (!pinnedText(words[at + 1]) || words.length < at + 3) return false;
  return words.slice(at + 2).every((signal) => !signal.dynamic && /^[A-Z][A-Z0-9]*$/.test(signal.value));
}

// awk and sed take their pinned program as the first operand after proved
// options. Later words are single-argument file operands and never
// option-shaped: GNU sed permutes options, so a later -e or -f adds a program.
function programOperand(options) {
  const table = optionTable(options);
  return (words, at) => {
    let index = at + 1;
    while (literalOption(words[index])) {
      index = optionEnd(words, index, table);
      if (index < 0) return false;
    }
    return (
      pinnedText(words[index]) &&
      words
        .slice(index + 1)
        .every((word) => singleArgument(word) && (word.value === "-" || !word.value.startsWith("-")))
    );
  };
}

// Declaration builtins assign fixed names; bash does not split their
// assignment arguments.
function declarationRoles(words, at) {
  return words
    .slice(at + 1)
    .every((word) => /^[A-Za-z_][A-Za-z0-9_]*(?:=|$)/.test(word.value) && !/\$\{?[@*]/.test(word.value));
}

// Forwarding and program rules list the modes they admit; terminals list their
// command shapes. benignAdmissionInventory publishes both.
const modes = (list, admit) => Object.assign((...args) => admit(...args), { modes: list.split(", ") });
const workflowFunction = terminal();
const programRules = new Map([
  // Prefixes and forwarders.
  ["timeout", modes("duration", timeoutPrefix)],
  ["nohup", modes("forward", (words, at, next) => next(at + 1))],
  ["npx", modes("forward", (words, at, next) => next(at + 1))],
  ["env", modes("assignments", envPrefix)],
  ["exec", modes("forward", execPrefix)],
  ["command", modes("forward, -v", commandPrefix)],
  ["pnpm", modes("exec, dlx, run, install, --filter run, --filter test, --filter origin", pnpmRoles)],
  [
    "docker",
    Object.assign(modes("exec, run, run alpine/helm:3.15.4, run ghcr.io/yannh/kubeconform:v0.6.7", dockerRoles), {
      terminals: [
        ["docker", dockerTerminal],
        ["docker compose", composeTerminal],
      ],
    }),
  ],
  ["kubectl", Object.assign(modes("exec, create job", kubectlRoles), { terminals: [["kubectl", kubectlTerminal]] })],
  ["find", modes("-type f -name", findRoles)],
  ["eval", modes("program", evalProgram)],
  ...[...shellInterpreters].map((name) => [name, modes("-c", shellProgram)]),
  ...Object.entries(interpreterModes).map(([name, mode]) => [
    name,
    modes([mode.program, mode.stdin && "-", mode.query, "script"].filter(Boolean).join(", "), interpreterRoles),
  ]),
  ["tsx", modes("script", (words, at) => pinnedOperand(words[at + 1]) && words.slice(at + 2).every(singleArgument))],
  ["psql", modes("options", psqlRoles)],
  ["trap", modes("action", trapRoles)],
  ["awk", modes("program", programOperand("-F:1 -v:1"))],
  ["sed", modes("program", programOperand("-i"))],
  ["local", modes("declarations", declarationRoles)],
  ["export", modes("declarations", declarationRoles)],
  // Non-forwarding utilities with origin-proved command shapes and options.
  ["terraform-init-with-retry.sh", terminal({ shapes: { "": "-reconfigure -backend-config=" } })],
  [
    "playwright",
    terminal({
      shapes: {
        "": { options: "--version", operands: 0 },
        install: "--with-deps",
        test: "--project=",
      },
    }),
  ],
  ["kubeconform", terminal({ shapes: { "": "-schema-location:1 -strict -summary -ignore-missing-schemas" } })],
  [
    "helm",
    terminal({
      shapes: {
        "get values": "--namespace:1 --output:1 --revision:1",
        history: "--namespace:1 --output:1",
        status: "--namespace:1",
        lint: "",
        template: "",
      },
    }),
  ],
  ["kubectl-argo-rollouts", terminal({ shapes: { "": { options: "--help", operands: 0 }, version: { operands: 0 } } })],
  [
    "git",
    terminal({
      shapes: {
        "cat-file": "-e",
        checkout: "--detach -B:1",
        "config --global init.defaultBranch": { operands: 1 },
        "config user.email": { operands: 1 },
        "config user.name": { operands: 1 },
        fetch: "--quiet --no-tags --no-recurse-submodules --tags",
        init: { options: "--quiet", operands: 0 },
        "ls-files": "",
        merge: "--ff-only",
        "merge-base": "--is-ancestor",
        push: "",
        "remote add": "",
        "rev-list": "--count --max-parents= -n:1",
        "rev-parse": "--verify --quiet",
        show: "-s --diff-merges= --format=",
        "show-ref": "--verify --quiet",
        tag: "--points-at:1 --list -a -m:1",
      },
    }),
  ],
  [
    "gh",
    terminal({
      shapes: {
        api: "--method:1 -f:1 --paginate --slurp --jq:1",
        "issue close": "--repo:1 --comment:1",
        "issue comment": "--repo:1 --body:1",
        "issue create": { options: "--repo:1 --title:1 --body:1 --label:1", variadic: true },
        "issue edit": "--repo:1 --body:1",
        "issue list": { options: "--repo:1 --state:1 --search:1 --limit:1 --json:1 --jq:1", operands: 0 },
        "run download": "--repo:1 --dir:1",
        "run view": "--repo:1 --json:1",
        "workflow run": "--repo:1 --ref:1 -f:1 --field:1",
      },
    }),
  ],
  [
    "aws",
    terminal({
      shapes: {
        "s3api delete-object": { options: "--bucket:1 --key:1 --endpoint-url:1", operands: 0 },
        "s3api head-object": { options: "--bucket:1 --key:1 --endpoint-url:1", operands: 0 },
        "s3api list-objects-v2": { options: "--bucket:1 --max-items:1 --endpoint-url:1", operands: 0 },
        "s3api put-object": { options: "--bucket:1 --key:1 --body:1 --endpoint-url:1", operands: 0 },
      },
    }),
  ],
  [
    "curl",
    terminal({
      shapes: {
        "": "--data:1 --fail --head --header:1 --location --max-time:1 --output:1 --retry:1 --retry-all-errors --retry-delay:1 --show-error --silent --write-out:1 -o:1 -sS -sSL -w:1",
      },
    }),
  ],
  ["jq", terminal({ shapes: { "": "--arg:2 --argjson:2 -c -cer -cn -e -er -n -r" } })],
  ["grep", terminal({ shapes: { "": "-- -E -Eq -Eqi -F -Fqx -qi -v" } })],
  ["tar", terminal({ shapes: { "": "-C:1 -czf:1" } })],
  ["rm", terminal({ shapes: { "": "-- -f -rf" } })],
  ["pg_isready", terminal({ shapes: { "": { options: "-U:1 -d:1", operands: 0 } } })],
  ["base64", terminal({ shapes: { "": { options: "--decode", operands: 0 } } })],
  ["cmp", terminal({ shapes: { "": "-s" } })],
  ["cut", terminal({ shapes: { "": "-c1-8" } })],
  ["date", terminal({ shapes: { "": "-d:1 -u" } })],
  ["free", terminal({ shapes: { "": { options: "-m", operands: 0 } } })],
  ["head", terminal({ shapes: { "": "-n:1" } })],
  ["tail", terminal({ shapes: { "": "-n:1" } })],
  ["kill", terminal({ shapes: { "": "-0" } })],
  ["mktemp", terminal({ shapes: { "": { options: "-d", operands: 0 } } })],
  ["sha256sum", terminal({ shapes: { "": "--check" } })],
  ["tee", terminal({ shapes: { "": "-a" } })],
  ["tr", terminal({ shapes: { "": "-d" } })],
  ["set", terminal({ shapes: { "": "-Eeuo:1 -euo:1 -o:1 -e" } })],
  ["read", terminal({ shapes: { "": "-r" } })],
  ["mapfile", terminal({ shapes: { "": "-t" } })],
  ["exit", terminal({ shapes: { "": { variadic: true } } })],
  ...[
    "basename",
    "dirname",
    "touch",
    "sort",
    "seq",
    "sleep",
    "cd",
    "return",
    "break",
    "continue",
    "true",
    ":",
    "disown",
  ].map((name) => [name, terminal()]),
  ...[
    "add_optional_runtime_env",
    "boot_smoke",
    "collect_proof_diagnostics",
    "fail",
    "has_state_address",
    "init_remote",
    "move_production_resource",
    "probe_key",
    "pull_source_state",
    "read_field",
    "require_job",
    "restore_remote_states",
    "restore_state_on_error",
    "verify_plan",
    "wait_for_domain",
  ].map((name) => [name, workflowFunction]),
]);

// Closed dispatch: the hop at `at` must resolve to a selector with a rule, and
// that rule must prove every role it reaches, redispatching forwarded hops.
function admitsProgramAt(words, at, context) {
  const selector = hopSelector(words[at]);
  const rule = selector === null ? undefined : programRules.get(selector);
  return Boolean(rule) && rule(words, at, (next) => admitsProgramAt(words, next, context), context);
}

// The closed admission inventory, one row per program mode or terminal shape.
// Tests bind their behavior matrix to it; admission itself never reads it.
export function benignAdmissionInventory() {
  const terminalRows = (selector, rule) =>
    rule.shapes.map(({ path, options, operands, variadic }) => ({
      selector,
      kind: "terminal",
      path: path.join(" "),
      global: Object.fromEntries(rule.global),
      options: Object.fromEntries(options),
      operands,
      variadic,
    }));
  return [...programRules].flatMap(([selector, rule]) => [
    ...(rule.modes ?? []).map((mode) => ({ selector, kind: "program", mode })),
    ...(rule.terminals ?? []).flatMap(([prefix, terminalRule]) => terminalRows(prefix, terminalRule)),
    ...(rule.shapes ? terminalRows(selector, rule) : []),
  ]);
}

// Shells and eval at any index, including fixed-dynamic spellings, must carry
// exactly one pinned program and nothing after it.
function shellOrEvalAnywhereUnpinned(words) {
  return words.some((word, index) => {
    const selector = hopSelector(word);
    if (shellInterpreters.has(selector)) return !shellProgram(words, index);
    if (selector === "eval") return !evalProgram(words, index);
    return false;
  });
}

function benignShapeViolation(entry) {
  const { id, selector, dataOperands, words, input } = entry;
  const shape = dataOperands ? { selector, dataOperands } : { selector, words, ...(input?.length ? { input } : {}) };
  if (id !== sha256(JSON.stringify(shape))) return `${id}: changed benign form identity.`;
  const proved =
    typeof entry.proof?.selector === "string" &&
    entry.proof.selector.length > 0 &&
    typeof entry.proof?.operands === "string" &&
    entry.proof.operands.length > 0;
  const origin = entry.origin ?? {};
  const located =
    /^[a-f0-9]{40}$/.test(origin.sha ?? "") &&
    typeof origin.path === "string" &&
    origin.path.startsWith(".github/workflows/") &&
    typeof origin.job === "string" &&
    origin.job.length > 0 &&
    Number.isInteger(origin.step) &&
    origin.step > 0;
  if (!proved || !located) return `${id}: incomplete benign form proof or corpus identity.`;
  if (dataOperands !== undefined) {
    return dataOperands === true && dataOperandSelectors.has(selector) && words === undefined && input === undefined
      ? null
      : `${id}: selector or payload hole is not data.`;
  }
  const wellFormed =
    Array.isArray(words) &&
    words.length > 0 &&
    words.every(
      (word) =>
        typeof word?.value === "string" && typeof word.dynamic === "boolean" && typeof word.quoted === "boolean",
    ) &&
    (input === undefined || (Array.isArray(input) && input.every((document) => typeof document === "string")));
  if (!wellFormed || words[0].value !== selector || words[0].dynamic) return `${id}: unresolved benign selector.`;
  return null;
}

function benignAdmissionViolations(entry, grammar) {
  const shape = benignShapeViolation(entry);
  if (shape) return [shape];
  if (entry.dataOperands) return [];
  return roleViolations(entry, entry.words, grammar, entryOriginWitness(entry));
}

// Covered-token and role admission over `words`: the stored entry words when
// validating, the actual lexed tokens when classifying a match. `origin` is the
// boot_smoke witness that context proves, or null.
function roleViolations(entry, words, grammar, origin) {
  const covered =
    [...words.map((word) => word.value), ...(entry.input ?? [])].some(containsCoveredToken) ||
    words.some((word, index) => {
      if ((hopSelector(word) ?? basename(word.value)) !== "node") return false;
      const result = classifyCommand({ words: words.slice(index), redirects: [], assignments: [] }, grammar);
      return Boolean(result?.operation) || result?.disposition === "INDETERMINATE";
    });
  if (covered) return [`${entry.id}: benign payload contains a covered invocation.`];
  if (!admitsProgramAt(words, 0, { input: entry.input, origin }) || shellOrEvalAnywhereUnpinned(words))
    return [`${entry.id}: benign payload admits an unpinned program.`];
  return [];
}

function dataOperandsMatch(selector, words) {
  if (selector === "[" || selector === "test") {
    if (selector === "[" && words.at(-1)?.value !== "]") return false;
    let args = words.slice(1, selector === "[" ? -1 : undefined);
    if (args[0]?.value === "!" && !args[0].dynamic) args = args.slice(1);
    const unary = args.length === 2 && !args[0].dynamic && ["-f", "-n", "-z", "-s"].includes(args[0].value);
    const binary =
      args.length === 3 && !args[1].dynamic && ["=", "!=", "-eq", "-ne", "-ge", "-gt", "-lt"].includes(args[1].value);
    return unary || binary;
  }
  if (selector === "install")
    return words.length === 5 && words[1]?.value === "-m" && /^0?[0-7]{3}$/.test(words[2]?.value);
  if (selector === "printf") return !words[1]?.dynamic && !words[1]?.value.startsWith("-");
  if (selector === "[[") {
    if (words.at(-1)?.value !== "]]") return false;
    const comparison = (word) => ["==", "!=", "=~"].includes(word?.value);
    return (
      (words.length === 5 && comparison(words[2])) ||
      (words.length === 6 && words[1]?.value === "!" && comparison(words[3]))
    );
  }
  return true;
}

// The first matching entry that admits the actual command, or the named
// refusal of a matching entry that does not.
function benignFormMatch(command, grammar, origin) {
  const { words } = command;
  if (words[0]?.dynamic) return { admitted: false, refusal: null };
  const input = JSON.stringify(
    command.redirects.filter(({ target }) => target?.body !== undefined).map(({ target }) => target.body),
  );
  const exactMatch = (entry) =>
    Array.isArray(entry.words) &&
    entry.words.length === words.length &&
    JSON.stringify(entry.input ?? []) === input &&
    entry.words.every(
      (word, index) =>
        word?.value === words[index].value &&
        word.dynamic === words[index].dynamic &&
        word.quoted === words[index].quoted,
    );
  // The cheap shape match runs first; admission over the actual tokens and
  // their origin context still decides every match.
  let refusal = null;
  for (const entry of grammar.benignForms ?? []) {
    if (entry.selector !== words[0]?.value) continue;
    const dataOnly = entry.dataOperands === true;
    if (!(dataOnly ? dataOperandsMatch(entry.selector, words) : exactMatch(entry))) continue;
    const shape = benignShapeViolation(entry);
    const [violation] = shape ? [shape] : dataOnly ? [] : roleViolations(entry, words, grammar, origin);
    if (!violation) return { admitted: true, refusal: null };
    refusal ??= violation;
  }
  return { admitted: false, refusal };
}

const nodeEvaluationOptions = new Set([
  "--eval",
  "--print",
  "-e",
  "-p",
  "-pe",
  "--check",
  "-c",
  "--help",
  "-h",
  "--version",
  "-v",
  "--run",
]);

function classifyTerraform(words, grammar, benign, destructive, unknown) {
  const options = consumeOptions(words, 1, handledForms(grammar, "terraform-option"));
  if (options.reason) return unknown(options.reason);
  const subcommand = words[options.index];
  if (!subcommand) return benign();
  const listed = handledForms(grammar, "terraform-command").some(
    (form) => form.name === subcommand.value || form.name.startsWith(`${subcommand.value} `),
  );
  if (subcommand.dynamic || !listed) return unknown("unlisted Terraform command");
  return subcommand.value === "destroy" ? destructive("terraform:destroy") : benign();
}

function classifyDoctl(words, grammar, benign, destructive, unknown) {
  const options = handledForms(grammar, "doctl-option");
  const groups = handledForms(grammar, "doctl-group");
  const commandForms = handledForms(grammar, "doctl-command");
  let position = consumeOptions(words, 1, options);
  if (position.reason) return unknown(position.reason);
  const root = words[position.index];
  if (!root) return benign();
  if (!groups.find((group) => group.names[0] === "registry")?.names.includes(root.value)) {
    const roots = handledForms(grammar, "doctl-root").map((form) =>
      form.registration.replace(/Cmd$/, "").toLowerCase(),
    );
    return !root.dynamic && roots.includes(root.value.replaceAll("-", ""))
      ? benign()
      : unknown("unlisted doctl root command");
  }
  position = consumeOptions(words, position.index + 1, options);
  if (position.reason) return unknown(position.reason);
  const group = groups.find((candidate) => candidate.names.includes(words[position.index]?.value));
  if (!group) {
    const registryCommand = commandForms.some(
      (form) => form.group === "registry" && form.names.includes(words[position.index]?.value),
    );
    return registryCommand ? benign() : unknown("unlisted registry command");
  }
  position = consumeOptions(words, position.index + 1, options);
  if (position.reason) return unknown(position.reason);
  const form = commandForms.find(
    (candidate) => candidate.group === group.names[0] && candidate.names.includes(words[position.index]?.value),
  );
  if (!form) return unknown("unlisted registry subcommand");
  if (group.names[0] === "repository" && form.names[0] === "delete-tag")
    return destructive("doctl:registry-repository-delete-tag");
  if (group.names[0] === "garbage-collection" && form.names[0] === "start")
    return destructive("doctl:registry-garbage-collection-start");
  return benign();
}

function classifyNode(words, grammar, benign, destructive, unknown) {
  const options = handledForms(grammar, "node-option");
  for (const alias of handledForms(grammar, "node-alias")) {
    const target = options.find((option) => option.names.includes(alias.targets[0]));
    if (target && !alias.name.includes(" ") && !alias.name.endsWith("="))
      options.push({ ...target, names: [alias.name], targets: alias.targets });
  }
  const consumed = consumeOptions(words, 1, options);
  if (consumed.reason) return unknown(consumed.reason);
  if (consumed.used.some((name) => nodeEvaluationOptions.has(name))) return benign();
  const script = words[consumed.index];
  if (!script || script.value === "-") return benign();
  if (script.dynamic && !/^[A-Za-z0-9_.-]+$/.test(basename(script.value)))
    return unknown("dynamic Node script position");
  const operation = scriptOperations.get(basename(script.value));
  return operation ? { ...destructive(operation), scriptIndex: consumed.index, words } : benign();
}

function classifyCommand(command, grammar, origin = null) {
  let { words } = command;
  if (!words.length) return null;
  const unknown = (reason) => ({
    disposition: "INDETERMINATE",
    tool: words[0]?.value ?? "shell",
    reason,
    index: words[0]?.index ?? 0,
    command,
  });
  if (["time", "coproc", "select"].includes(words[0]?.value))
    return unknown(`unsupported ${words[0].value} production`);
  while (["command", "exec", "env"].includes(words[0]?.value) && !words[0].dynamic) {
    const wrapper = words[0].value;
    words = words.slice(1);
    if (wrapper === "command" && ["-v", "-V"].includes(words[0]?.value)) return null;
    if (wrapper === "command" && words[0]?.value === "-p") words = words.slice(1);
    if (wrapper === "command" && words[0]?.value === "--") words = words.slice(1);
    if (words[0]?.value.startsWith("-")) return unknown(`unsupported ${wrapper} option`);
    if (wrapper === "env") while (assignmentWord(words[0]?.value)) words = words.slice(1);
    if (!words.length) return unknown(`missing ${wrapper} executable`);
  }
  const selector = fixedSelector(words[0]);
  if (!selector) return unknown("unresolved dynamic executable");
  const tool = basename(selector);
  const benign = () => ({ disposition: "HANDLED", tool, operation: null, index: words[0]?.index, command });
  const destructive = (operation) => ({ ...benign(), operation });
  const scriptOperation = scriptOperations.get(tool);
  if (scriptOperation) return destructive(scriptOperation);
  if (tool === "terraform") return classifyTerraform(words, grammar, benign, destructive, unknown);
  if (tool === "doctl") return classifyDoctl(words, grammar, benign, destructive, unknown);
  if (tool === "node") return classifyNode(words, grammar, benign, destructive, unknown);
  const match = benignFormMatch({ ...command, words }, grammar, origin);
  return match.admitted ? null : unknown(match.refusal ?? "unlisted executable form");
}

const defaultGrammarProof = validateGrammarPartition();
const grammarProof = (grammar) =>
  grammar === DESTRUCTIVE_GRAMMAR ? defaultGrammarProof : validateGrammarPartition(grammar);

export function classifyShellCommands(run, { grammar = DESTRUCTIVE_GRAMMAR } = {}) {
  if (typeof run !== "string") return { invocations: [], operations: [], indeterminate: [] };
  return classifyRun(run, grammar, grammarProof(grammar));
}

// A complete run block. Only a block that is exactly an origin witness carries
// that witness, and only into its proved substitution occurrence.
function classifyRun(run, grammar, proof) {
  const witness = runOriginWitness(run);
  return classifyProvedRun(witness?.run ?? run, grammar, proof, witness);
}

// One grammar proof covers a run and every substitution nested in it.
function classifyProvedRun(run, grammar, proof, witness = null, origin = null) {
  if (!proof.passed) {
    const unknown = { tool: "grammar", index: 0, disposition: "INDETERMINATE", reason: proof.violations.join("; ") };
    return { invocations: [unknown], operations: [], indeterminate: [unknown] };
  }
  const lexed = shellTokens(run);
  const commands = commandsFromTokens(lexed.tokens);
  for (const production of lexed.productions) {
    const handled = grammar.partition.some(
      (member) =>
        member.surface === "shell" && member.form.production === production && member.disposition === "HANDLED",
    );
    if (!handled) lexed.errors.push(`INDETERMINATE shell production ${production}`);
  }
  lexed.errors.push(...shellSyntaxErrors(lexed.tokens, commands, grammar));
  const invocations = commands
    .map((command) => classifyCommand(resolveCommandWords(command, commands, lexed.tokens), grammar, origin))
    .filter(Boolean);
  for (const substitution of lexed.substitutions) {
    const bound = witness !== null && substitution.index === witness.occurrence ? witness : null;
    for (const invocation of classifyProvedRun(substitution.run, grammar, proof, null, bound).invocations)
      invocations.push({ ...invocation, index: substitution.index + invocation.index });
  }
  if (lexed.errors.length) {
    if (!invocations.length) invocations.push({ tool: "shell", index: 0 });
    const reason = lexed.errors.join(", ");
    for (const invocation of invocations) {
      invocation.disposition = "INDETERMINATE";
      invocation.reason = reason;
    }
  }
  invocations.sort((left, right) => left.index - right.index);
  return {
    invocations,
    operations: invocations.filter((invocation) => invocation.operation).map((invocation) => invocation.operation),
    indeterminate: invocations.filter((invocation) => invocation.disposition === "INDETERMINATE"),
  };
}

// ---------------------------------------------------------------------------
// Workflow shape contract. These are shape proofs over the cleanup workflows,
// not dataflow, ownership or reachability proofs.

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

const cancellationSafeGate =
  "!cancelled() && (needs.refuse-unconfirmed-apply.result == 'skipped' || needs.refuse-unconfirmed-apply.result == 'success')";
const catalogResetCondition =
  "!cancelled() && needs.refuse-production.result == 'skipped' && needs.refuse-unconfirmed-apply.result == 'skipped'";

function expression(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const environment = (...owners) => Object.assign({}, ...owners.map((owner) => owner?.env ?? {}));
const inputVariables = (env, input) =>
  Object.entries(env)
    .filter(([, value]) => expression(value) === `github.event.inputs.${input}`)
    .map(([name]) => name);
const needs = (job) => {
  if (typeof job?.needs === "string") return [job.needs];
  return Array.isArray(job?.needs) ? job.needs : [];
};
const noConfirmationDefault = (input) => input?.type === "string" && !Object.hasOwn(input, "default");
const nonzeroExit = (tokens) =>
  commandsFromTokens(tokens).some(
    ({ words }) => words[0]?.value === "exit" && /^[1-9]\d*$/.test(words[1]?.value ?? ""),
  );
const variableSpellings = (name) => [`$${name}`, `\${${name}}`];

function commandHead(tokens, index) {
  const previous = tokens[index - 1];
  if (!previous) return true;
  if (previous.type === "operator")
    return ["\n", ";", ";;", ";&", ";;&", "&&", "||", "|", "&", "(", ")"].includes(previous.value);
  return !previous.quoted && ["then", "else", "do", "{"].includes(previous.value);
}

// Only the case branches the cleanup contracts use are interpreted.
function caseAt(tokens, start) {
  if (tokens[start]?.value !== "case" || tokens[start + 2]?.value !== "in") return null;
  const branches = [];
  let index = start + 3;
  while (index < tokens.length) {
    while (tokens[index]?.value === "\n") index += 1;
    if (tokens[index]?.value === "esac") return { selector: tokens[start + 1], branches, end: index };
    const patterns = [];
    for (; index < tokens.length && tokens[index].value !== ")"; index += 1)
      if (!["|", "(", "\n"].includes(tokens[index].value)) patterns.push(tokens[index].value);
    if (index === tokens.length) return null;
    index += 1;
    const bodyStart = index;
    let depth = 0;
    for (; index < tokens.length; index += 1) {
      if (tokens[index].value === "case") depth += 1;
      if (tokens[index].value === "esac") depth -= 1;
      if (depth === 0 && tokens[index].value === ";;") break;
    }
    if (index === tokens.length) return null;
    branches.push({ patterns, tokens: tokens.slice(bodyStart, index) });
    index += 1;
  }
  return null;
}

const cases = (tokens) =>
  tokens.flatMap((token, index) =>
    token.value === "case" && !token.quoted && commandHead(tokens, index)
      ? [caseAt(tokens, index)].filter(Boolean)
      : [],
  );
const branch = (control, pattern) =>
  control?.branches.find((candidate) => candidate.patterns.length === 1 && candidate.patterns[0] === pattern);
const selectsVariable = (control, names) =>
  control.selector.dynamic && names.some((name) => variableSpellings(name).includes(control.selector.value));

// `if [ "$variable" != <phrase> ]; then ... exit N ... fi` at a command head.
function exactComparisonRefusal(tokens, variable, phrase = null) {
  const significant = tokens.filter((token) => token.value !== "\n");
  const values = significant.map((token) => token.value);
  for (let index = 0; index < values.length; index += 1) {
    if (
      values[index] !== "if" ||
      significant[index].quoted ||
      !commandHead(tokens, tokens.indexOf(significant[index])) ||
      values[index + 1] !== "[" ||
      !variableSpellings(variable).includes(values[index + 2]) ||
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
    const fiIndex = significant.findIndex((token, position) => position > thenIndex && token.value === "fi");
    if (
      fiIndex > thenIndex &&
      nonzeroExit(tokens.slice(tokens.indexOf(significant[thenIndex]) + 1, tokens.indexOf(significant[fiIndex])))
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
        selectsVariable(control, modeNames) &&
        control.branches.length === 3 &&
        branch(control, "true") &&
        branch(control, "false") &&
        branch(control, "*") &&
        confirmationNames.some((name) => exactComparisonRefusal(branch(control, "false").tokens, name)) &&
        nonzeroExit(branch(control, "*").tokens),
    );
  });
}

// `echo TARGET=$variable >> "$GITHUB_ENV"` publications.
function publications(tokens) {
  return commandsFromTokens(tokens).flatMap(({ words, redirects }) => {
    const published = redirects.some(
      ({ operator, target }) => operator === ">>" && target?.dynamic && target.value === "$GITHUB_ENV",
    );
    if (words[0]?.value !== "echo" || words.length !== 2 || !words[1].dynamic || !published) return [];
    const match = /^([A-Z][A-Z0-9_]*)=\$\{?([A-Za-z_]\w*)\}?$/.exec(words[1].value);
    return match ? [{ target: match[1], variable: match[2] }] : [];
  });
}

const plainAssignment = (tokens, variable, value) =>
  commandsFromTokens(tokens).some(
    (command) =>
      command.words.length === 0 &&
      command.assignments.some(
        (candidate) => candidate.name === variable && candidate.value === value && !candidate.token.dynamic,
      ),
  );
const arrayAssignment = (tokens, variable, values) =>
  commandsFromTokens(tokens).some(
    (command) =>
      command.words.length === 0 &&
      command.assignments.some(
        (candidate) =>
          candidate.name === variable &&
          candidate.array &&
          candidate.array.every((token) => !token.dynamic) &&
          JSON.stringify(candidate.array.map((token) => token.value)) === JSON.stringify(values),
      ),
  );

function dryRunResolver(publication, controls, env) {
  return controls.some((control) => {
    const name = control.selector.value.replace(/^\$\{?|\}$/g, "");
    return (
      control.selector.dynamic &&
      publication.variable === name &&
      expression(env[name]) === "github.event_name == 'schedule' && 'false' || github.event.inputs.dry_run" &&
      control.branches.length === 2 &&
      control.branches[0].patterns.join(",") === "true,false" &&
      publications(control.branches[0].tokens).some(
        (output) => output.target === publication.target && output.variable === name,
      ) &&
      branch(control, "*") &&
      nonzeroExit(branch(control, "*").tokens)
    );
  });
}

function applyResolver(publication, controls, env) {
  return controls.some((control) => {
    if (!control.selector.dynamic || control.selector.value !== "$GITHUB_EVENT_NAME" || control.branches.length !== 3)
      return false;
    const schedule = branch(control, "schedule");
    const manual = branch(control, "workflow_dispatch");
    const unknown = branch(control, "*");
    if (!schedule || !manual || !unknown) return false;
    if (!plainAssignment(schedule.tokens, publication.variable, "true") || !nonzeroExit(unknown.tokens)) return false;
    const modeNames = inputVariables(env, "dry_run");
    return cases(manual.tokens).some(
      (mode) =>
        selectsVariable(mode, modeNames) &&
        mode.branches.length === 3 &&
        branch(mode, "true") &&
        branch(mode, "false") &&
        branch(mode, "*") &&
        plainAssignment(branch(mode, "true").tokens, publication.variable, "false") &&
        plainAssignment(branch(mode, "false").tokens, publication.variable, "true") &&
        nonzeroExit(branch(mode, "*").tokens),
    );
  });
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
      if (dryRunResolver(publication, controls, env)) candidates.push({ ...publication, kind: "dry-run" });
      else if (applyResolver(publication, controls, env)) candidates.push({ ...publication, kind: "apply" });
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
        const wired = variableSpellings(resolver.target).map((spelling) => `--dry-run=${spelling}`);
        return args.some((word) => word.dynamic && wired.includes(word.value));
      }
      if (invocation.operation !== "script:production-db-restore-point-cleanup" || resolver.kind !== "apply")
        return false;
      const applyEnvironment = environment(
        workflow,
        detected.job,
        detected.step,
      ).PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY;
      if (applyEnvironment !== undefined && applyEnvironment !== "false") return false;
      return cases(shellTokens(detected.step.run).tokens).some((control) => {
        if (!selectsVariable(control, [resolver.target]) || control.branches.length !== 3) return false;
        const apply = branch(control, "true");
        const dryRun = branch(control, "false");
        const unknown = branch(control, "*");
        if (!apply || !dryRun || !unknown || !nonzeroExit(unknown.tokens)) return false;
        return apply.tokens.some((token) => {
          const name = /^([A-Za-z_]\w*)=$/.exec(token.value)?.[1];
          return (
            Boolean(name) &&
            arrayAssignment(apply.tokens, name, ["--apply"]) &&
            arrayAssignment(dryRun.tokens, name, []) &&
            args.some((argument) => argument.dynamic && argument.value === `\${${name}[@]}`) &&
            !args.some((argument) => argument.value === "--apply")
          );
        });
      });
    });
}

const safeDependency = (job) =>
  needs(job).includes("refuse-unconfirmed-apply") && expression(job.if) === cancellationSafeGate;

function parseWorkflow(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  const workflow = document.toJS();
  const mapping = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (
    !mapping(workflow) ||
    !mapping(workflow.jobs) ||
    Object.values(workflow.jobs).some((job) => !mapping(job) || (job.steps !== undefined && !Array.isArray(job.steps)))
  )
    throw new Error("workflow must contain a jobs mapping");
  return workflow;
}

function classifyStep(workflow, job, step, grammar, proof) {
  const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell ?? "bash";
  if (/^bash(?:\s|$)/.test(shell)) return classifyRun(step.run, grammar, proof);
  return { operations: [], indeterminate: [{ tool: shell, reason: "unproved non-Bash run step" }] };
}

function gateViolations(workflow, workflowFile) {
  const violations = [];
  let triggers = Object.keys(workflow.on ?? {});
  if (typeof workflow.on === "string") triggers = [workflow.on];
  else if (Array.isArray(workflow.on)) triggers = workflow.on;
  if ([...triggers].sort().join(",") !== "schedule,workflow_dispatch")
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
  return violations;
}

export function checkWorkflowDestructiveOperationGating(
  source,
  { workflowFile = "workflow", grammar = DESTRUCTIVE_GRAMMAR } = {},
) {
  return checkWorkflow(source, workflowFile, grammar);
}

// `proof` lets discovery prove a grammar once for every workflow it inspects.
function checkWorkflow(source, workflowFile, grammar, proof) {
  const violations = [];
  let workflow;
  try {
    workflow = parseWorkflow(source);
  } catch (error) {
    return {
      passed: false,
      checkedSteps: [],
      violations: [`${workflowFile}: workflow could not be parsed; failing closed (${error.message}).`],
    };
  }
  const detected = [];
  const stepProof = proof ?? grammarProof(grammar);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (typeof step?.run !== "string") continue;
      const classification = classifyStep(workflow, job, step, grammar, stepProof);
      if (!classification.operations.length && !classification.indeterminate.length) continue;
      detected.push({ jobId, job, step, stepIndex: index + 1, classification, operations: classification.operations });
      for (const unknown of classification.indeterminate)
        violations.push(
          `${workflowFile}: job '${jobId}' step #${index + 1}: INDETERMINATE ${unknown.tool}: ${unknown.reason}; failing closed.`,
        );
    }
  }
  const signature = (stepOperations) => stepOperations.map((operations) => [...operations].sort().join("+")).sort();
  const exempt = new Set();
  const inventory = DESTRUCTIVE_OPERATION_EXEMPTIONS.find((entry) => entry.workflowFile === workflowFile);
  for (const declared of inventory?.jobs ?? []) {
    const actual = detected.filter((entry) => entry.jobId === declared.jobId);
    const uncertain = actual.some((entry) => entry.classification.indeterminate.length);
    const exact =
      JSON.stringify(signature(actual.map((entry) => entry.operations))) ===
      JSON.stringify(signature(declared.expectedStepOperations));
    if (uncertain || !exact)
      violations.push(
        `${workflowFile}: bounded destructive-operation exemption for job '${declared.jobId}' changed; exact invocation multiset required (no additions, removals, or INDETERMINATE forms).`,
      );
    else for (const entry of actual) exempt.add(entry);
  }
  const checkedSteps = detected.map((entry) => {
    let disposition = "provable-gate";
    if (entry.classification.indeterminate.length) disposition = "INDETERMINATE";
    else if (exempt.has(entry)) disposition = "bounded-exemption";
    return {
      jobId: entry.jobId,
      stepIndex: entry.stepIndex,
      name: entry.step.name ?? "unnamed step",
      operations: entry.operations,
      disposition,
    };
  });
  const gated = detected.filter((entry) => !exempt.has(entry));
  if (gated.length) violations.push(...gateViolations(workflow, workflowFile));
  const resolversByJob = new Map();
  for (const entry of gated) {
    if (!safeDependency(entry.job))
      violations.push(
        `${workflowFile}: destructive job '${entry.jobId}' must be cancellation-safe, need refuse-unconfirmed-apply, and accept only skipped or success.`,
      );
    if (!resolversByJob.has(entry.jobId)) resolversByJob.set(entry.jobId, safeResolvers(workflow, entry.job));
    const resolvers = resolversByJob.get(entry.jobId);
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

function stagingTripwire(workflow) {
  const step = workflow.jobs["reset-staging"]?.steps?.find(
    (candidate) => expression(candidate.env?.RESET_CONFIRM) === "inputs.confirm" && typeof candidate.run === "string",
  );
  const tokens = shellTokens(step?.run ?? "").tokens;
  return (
    noConfirmationDefault(workflow.on?.workflow_dispatch?.inputs?.confirm) &&
    Boolean(step) &&
    ["reset staging", "resume staging recreate"].every((phrase) =>
      exactComparisonRefusal(tokens, "RESET_CONFIRM", phrase),
    )
  );
}

function catalogTripwire(workflow) {
  const gate = workflow.jobs["refuse-unconfirmed-apply"];
  const job = workflow.jobs["catalog-integration-reset"];
  return (
    noConfirmationDefault(workflow.on?.workflow_dispatch?.inputs?.confirm) &&
    expression(gate?.if) === "inputs.action == 'apply' && inputs.confirm != 'reset staging catalog integration data'" &&
    !gate["continue-on-error"] &&
    (gate.steps ?? []).some(
      (step) => typeof step.run === "string" && !step["continue-on-error"] && nonzeroExit(shellTokens(step.run).tokens),
    ) &&
    ["refuse-production", "refuse-unconfirmed-apply"].every((name) => needs(job).includes(name)) &&
    expression(job?.if) === catalogResetCondition
  );
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
    if (file.endsWith("/platform-staging-reset.yml")) {
      if (!stagingTripwire(workflow))
        violations.push(
          `${file}: named reset tripwire requires an unset-by-default typed confirmation and actual nonzero refusal for both exact phrases.`,
        );
    } else if (!catalogTripwire(workflow)) {
      violations.push(
        `${file}: named reset tripwire requires actual nonzero refusal plus a cancellation-safe destructive-job dependency/result condition.`,
      );
    }
  }
  return { passed: violations.length === 0, checkedWorkflows: [...NAMED_RESET_WORKFLOW_TRIPWIRES], violations };
}

export function discoverWorkflowFiles(root = process.cwd()) {
  const visit = (directory, prefix) =>
    readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) return visit(join(directory, entry.name), relative);
        return entry.isFile() && /\.ya?ml$/.test(entry.name) ? [relative] : [];
      });
  return visit(join(root, ".github/workflows"), ".github/workflows");
}

export function checkDiscoveredWorkflows({ root = process.cwd(), grammar = DESTRUCTIVE_GRAMMAR } = {}) {
  const workflowFiles = discoverWorkflowFiles(root);
  const sources = {};
  const results = [];
  const violations = [...validateGrammarPartition(grammar).violations];
  const proof = grammarProof(grammar);
  for (const workflowFile of workflowFiles) {
    try {
      sources[workflowFile] = readFileSync(resolve(root, workflowFile), "utf8");
      const result = checkWorkflow(sources[workflowFile], workflowFile, grammar, proof);
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

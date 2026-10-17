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
  const originKeys = new Set();
  for (const record of grammar.origins ?? []) {
    if (originKeys.has(originKey(record)))
      violations.push(`${originKey(record).replaceAll("\u0000", ":")}: duplicate origin record.`);
    originKeys.add(originKey(record));
  }
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

  // Inside `[[ ... ]]` the operators &&, ||, !, (, ), < and > are conditional
  // words, and the operand after `=~` is a regular expression whose
  // parentheses, `|` and trailing `$` are literal.
  let condition = false;
  let regex = false;

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
    let depth = 0;
    const expansion = () => {
      dynamic = true;
      if (!quote) unprotected = true;
    };
    while (index < run.length) {
      const character = run[index];
      if (!quote && regex) {
        if (blank(character) && depth === 0) break;
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        if (character === "$" && !/[A-Za-z_{(]/.test(run[index + 1] ?? "")) {
          value += character;
          index += 1;
          continue;
        }
      } else if (!quote && (blank(character) || operatorAt(run, index))) break;
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
    regex = condition && !quoted && value === "=~";
    if (!quoted && value === "[[") condition = true;
    else if (!quoted && value === "]]") condition = false;
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
    } else if (condition && regex) {
      readWord();
    } else if (condition && ["&&", "||", "(", ")", "<", ">"].some((word) => run.startsWith(word, index))) {
      const value = ["&&", "||"].find((word) => run.startsWith(word, index)) ?? character;
      tokens.push({
        type: "word",
        value,
        dynamic: false,
        quoted: false,
        unprotected: false,
        pattern: false,
        index,
        raw: value,
      });
      index += value.length;
    } else if (condition && character === "\n") {
      index += 1;
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

// ---------------------------------------------------------------------------
// F4 operand leads. A dynamic word in a terminal-operand, forwarding-resource
// or find start-path position is admitted only when its leading expansion is
// proved at that exact site, from the actual run (its statement tree and
// every lexical writer of each name it reads) and the step/job/workflow env
// declarations. A proved lead cannot begin with `-`. L3-T/L4-T/LX/LR prove
// provenance only: R owns that residual, which `residual` names. Labels, IDs,
// hashes and names grant nothing; anything unsupported refuses.

const isOperator = (token, value) => token?.type === "operator" && token.value === value;
const isReserved = (token, value) => token?.type === "word" && !token.quoted && token.value === value;

// Statement tree over lexed tokens: lists of and-or statements of pipelines
// of simple or compound commands. Unsupported structure returns null.
function shellTree(tokens) {
  let index = 0;
  const fail = () => {
    throw new Error("unsupported shell structure");
  };
  const expectWord = (value) => {
    if (!isReserved(tokens[index], value)) fail();
    index += 1;
  };
  const skipNewlines = () => {
    while (isOperator(tokens[index], "\n")) index += 1;
  };
  const redirected = (node) => {
    node.redirects = [];
    while (tokens[index]?.type === "operator" && redirections.has(tokens[index].value)) {
      node.redirects.push({ operator: tokens[index].value, target: tokens[index + 1] });
      index += 2;
    }
    return node;
  };
  const list = (parent, role, terminators) => {
    const node = { kind: "list", parent, role, items: [] };
    for (;;) {
      while (isOperator(tokens[index], "\n") || isOperator(tokens[index], ";")) index += 1;
      const token = tokens[index];
      if (!token) break;
      if (token.type === "word" && !token.quoted && terminators.has(token.value)) break;
      if (token.type === "operator" && [")", ";;", ";&", ";;&"].includes(token.value)) break;
      const statement = {
        kind: "statement",
        parent: node,
        list: node,
        index: node.items.length,
        chain: [],
        async: false,
      };
      node.items.push(statement);
      statement.chain.push({ operator: null, pipeline: pipeline(statement) });
      while (isOperator(tokens[index], "&&") || isOperator(tokens[index], "||")) {
        const operator = tokens[index].value;
        index += 1;
        skipNewlines();
        statement.chain.push({ operator, pipeline: pipeline(statement) });
      }
      if (isOperator(tokens[index], "&")) {
        statement.async = true;
        index += 1;
      }
    }
    return node;
  };
  const pipeline = (parent) => {
    const node = { kind: "pipeline", parent, negated: false, elements: [] };
    if (isReserved(tokens[index], "!")) {
      node.negated = true;
      index += 1;
    }
    node.elements.push(compound(node));
    while (isOperator(tokens[index], "|") || isOperator(tokens[index], "|&")) {
      index += 1;
      skipNewlines();
      node.elements.push(compound(node));
    }
    return node;
  };
  const functionBody = (parent, name) => {
    skipNewlines();
    const node = { kind: "function", parent, name };
    node.body = compound(node);
    if (node.body.kind === "simple") fail();
    return node;
  };
  const compound = (parent) => {
    const token = tokens[index];
    if (!token) fail();
    if (isOperator(token, "(")) {
      index += 1;
      const node = { kind: "subshell", parent };
      node.body = list(node, "subshell", new Set());
      if (!isOperator(tokens[index], ")")) fail();
      index += 1;
      return redirected(node);
    }
    if (token.type === "word" && !token.quoted) {
      if (token.value === "if") {
        index += 1;
        const node = { kind: "if", parent, clauses: [], otherwise: null };
        for (;;) {
          const condition = list(node, "condition", new Set(["then"]));
          expectWord("then");
          const body = list(node, "then", new Set(["elif", "else", "fi"]));
          node.clauses.push({ condition, body });
          if (isReserved(tokens[index], "elif")) {
            index += 1;
            continue;
          }
          if (isReserved(tokens[index], "else")) {
            index += 1;
            node.otherwise = list(node, "else", new Set(["fi"]));
          }
          expectWord("fi");
          return redirected(node);
        }
      }
      if (token.value === "while" || token.value === "until") {
        index += 1;
        const node = { kind: token.value, parent };
        node.condition = list(node, "condition", new Set(["do"]));
        expectWord("do");
        node.body = list(node, "body", new Set(["done"]));
        expectWord("done");
        return redirected(node);
      }
      if (token.value === "for") {
        index += 1;
        const name = tokens[index];
        if (name?.type !== "word" || name.quoted || !/^[A-Za-z_]\w*$/.test(name.value)) fail();
        index += 1;
        const node = { kind: "for", parent, name: name.value, nameToken: name, items: null };
        if (isReserved(tokens[index], "in")) {
          index += 1;
          node.items = [];
          while (tokens[index]?.type === "word") node.items.push(tokens[index++]);
        }
        while (isOperator(tokens[index], ";") || isOperator(tokens[index], "\n")) index += 1;
        expectWord("do");
        node.body = list(node, "body", new Set(["done"]));
        expectWord("done");
        return redirected(node);
      }
      if (token.value === "case") {
        index += 1;
        const node = { kind: "case", parent, subject: tokens[index], arms: [] };
        index += 1;
        skipNewlines();
        expectWord("in");
        for (;;) {
          skipNewlines();
          if (isReserved(tokens[index], "esac")) {
            index += 1;
            return redirected(node);
          }
          if (isOperator(tokens[index], "(")) index += 1;
          const patterns = [];
          do {
            if (tokens[index]?.type !== "word") fail();
            patterns.push(tokens[index++]);
          } while (isOperator(tokens[index], "|") && ++index);
          if (!isOperator(tokens[index], ")")) fail();
          index += 1;
          node.arms.push({ patterns, body: list(node, "arm", new Set(["esac"])) });
          if ([";;", ";&", ";;&"].some((value) => isOperator(tokens[index], value))) index += 1;
          else if (!isReserved(tokens[index], "esac")) fail();
        }
      }
      if (token.value === "{") {
        index += 1;
        const node = { kind: "group", parent };
        node.body = list(node, "group", new Set(["}"]));
        expectWord("}");
        return redirected(node);
      }
      if (token.value === "function") {
        const name = tokens[index + 1];
        if (name?.type !== "word" || name.quoted) fail();
        index += 2;
        if (isOperator(tokens[index], "(") && isOperator(tokens[index + 1], ")")) index += 2;
        return functionBody(parent, name.value);
      }
      if (
        /^[A-Za-z_][\w-]*$/.test(token.value) &&
        isOperator(tokens[index + 1], "(") &&
        isOperator(tokens[index + 2], ")")
      ) {
        index += 3;
        return functionBody(parent, token.value);
      }
    }
    const start = index;
    while (index < tokens.length) {
      const current = tokens[index];
      if (current.type === "operator") {
        if (redirections.has(current.value)) {
          index += 2;
          continue;
        }
        if (current.value === "(" && index > start && emptyAssignment(tokens[index - 1]?.value)) {
          let depth = 0;
          for (; index < tokens.length; index += 1) {
            if (isOperator(tokens[index], "(")) depth += 1;
            else if (isOperator(tokens[index], ")") && --depth === 0) break;
          }
          index += 1;
          continue;
        }
        break;
      }
      index += 1;
    }
    if (index === start) fail();
    const slice = tokens.slice(start, index);
    const [command = { words: [], redirects: [], assignments: [] }] = commandsFromTokens(slice);
    return { kind: "simple", parent, tokens: slice, command, start: slice[0].index };
  };
  try {
    const root = list(null, "root", new Set());
    return index === tokens.length ? root : null;
  } catch {
    return null;
  }
}

function* treeNodes(node) {
  if (!node) return;
  yield node;
  switch (node.kind) {
    case "list":
      for (const statement of node.items) yield* treeNodes(statement);
      break;
    case "statement":
      for (const { pipeline } of node.chain) yield* treeNodes(pipeline);
      break;
    case "pipeline":
      for (const element of node.elements) yield* treeNodes(element);
      break;
    case "if":
      for (const clause of node.clauses) {
        yield* treeNodes(clause.condition);
        yield* treeNodes(clause.body);
      }
      yield* treeNodes(node.otherwise);
      break;
    case "while":
    case "until":
      yield* treeNodes(node.condition);
      yield* treeNodes(node.body);
      break;
    case "case":
      for (const arm of node.arms) yield* treeNodes(arm.body);
      break;
    case "for":
    case "group":
    case "subshell":
    case "function":
      yield* treeNodes(node.body);
      break;
  }
}

// The statement holding `node`, or null.
const statementOf = (node) => {
  let current = node;
  while (current && current.kind !== "statement") current = current.parent;
  return current;
};

// The simple command at a statement's list level when the statement always
// runs it whenever its list runs: first in its and-or chain, a lone
// non-negated pipeline element and not asynchronous.
function unconditionalSimple(statement) {
  const [{ pipeline } = {}] = statement?.chain ?? [];
  if (!pipeline || pipeline.negated || pipeline.elements.length !== 1 || statement.async) return null;
  return pipeline.elements[0];
}

// The ancestor statement of `node` that lies directly in `list`, or null.
function statementIn(list, node) {
  let current = node;
  while (current) {
    if (current.kind === "statement" && current.list === list) return current;
    current = current.parent;
  }
  return null;
}

// A writer at a list's statement level dominates a use that lies in a later
// statement of that same list (same invocation, iteration, arm or group).
function dominates(writerStatement, useNode) {
  const later = statementIn(writerStatement.list, useNode);
  return Boolean(later) && later.index > writerStatement.index;
}

const declarationBuiltins = new Set(["local", "declare", "typeset", "export", "readonly"]);
const readValuedOptions = new Set(["-a", "-d", "-i", "-n", "-N", "-p", "-t", "-u"]);
const mapfileValuedOptions = new Set(["-d", "-n", "-O", "-s", "-u", "-C", "-c"]);
const nameWord = /^[A-Za-z_]\w*$/;

// Every write one simple command makes, normalized across quoted builtins
// and command/builtin prefixes. `kind` is assign, append, array, prefix,
// local, declare, read, mapfile, unset, printf, getopts, positional or opaque.
function commandWrites(command) {
  const writes = [];
  for (const assignment of command.assignments) {
    const name = assignment.name.replace(/\+$/, "").replace(/\[.*$/, "");
    const append = assignment.name.endsWith("+");
    let kind = "assign";
    if (command.words.length) kind = "prefix";
    else if (assignment.array) kind = append ? "array-append" : "array";
    else if (append || assignment.name.includes("[")) kind = "append";
    writes.push({ name, kind, assignment });
  }
  let words = command.words;
  while (["builtin", "command"].includes(words[0]?.value) && !words[0].dynamic) words = words.slice(1);
  const selector = words[0]?.dynamic ? null : words[0]?.value;
  const operands = words.slice(1);
  if (declarationBuiltins.has(selector)) {
    for (const word of operands) {
      if (word.value.startsWith("-")) {
        if (/n/.test(word.value) || word.dynamic) writes.push({ name: null, kind: "opaque" });
        continue;
      }
      const separator = word.value.indexOf("=");
      const name = (separator < 0 ? word.value : word.value.slice(0, separator)).replace(/\+$/, "");
      if (!nameWord.test(name)) {
        writes.push({ name: null, kind: "opaque" });
        continue;
      }
      writes.push({
        name,
        kind: selector === "local" ? "local" : "declare",
        word,
        value: separator < 0 ? null : word.value.slice(separator + 1),
      });
    }
  } else if (selector === "read" || selector === "mapfile" || selector === "readarray") {
    const valued = selector === "read" ? readValuedOptions : mapfileValuedOptions;
    const targets = [];
    for (let index = 0; index < operands.length; index += 1) {
      const word = operands[index];
      if (word.value.startsWith("-") && !word.dynamic) {
        if (valued.has(word.value)) {
          if (word.value === "-a") targets.push(operands[index + 1]);
          index += 1;
        }
      } else targets.push(word);
    }
    for (const word of targets)
      writes.push(
        word && !word.dynamic && nameWord.test(word.value)
          ? { name: word.value, kind: selector === "read" ? "read" : "mapfile", word, command }
          : { name: null, kind: "opaque" },
      );
  } else if (selector === "unset") {
    for (const word of operands)
      if (!word.value.startsWith("-")) writes.push({ name: word.dynamic ? null : word.value, kind: "unset" });
  } else if (selector === "printf" && operands[0]?.value === "-v") {
    writes.push({ name: operands[1]?.dynamic ? null : operands[1]?.value, kind: "printf" });
  } else if (selector === "getopts") {
    writes.push({ name: operands[1]?.dynamic ? null : operands[1]?.value, kind: "getopts" });
  } else if (selector === "shift" || (selector === "set" && setsPositionals(operands))) {
    writes.push({ name: "@positional", kind: "positional" });
  } else if (selector === "trap" || selector === "eval") {
    // A pinned action is inventoried by runAnalysis; a dynamic one is opaque.
    if (!operands[0] || operands[0].dynamic) writes.push({ name: null, kind: "opaque" });
  } else if (["source", ".", "let"].includes(selector)) {
    writes.push({ name: null, kind: "opaque" });
  }
  for (const word of [...command.words, ...command.assignments.map(({ token }) => token)])
    for (const [, name] of (word.raw ?? word.value).matchAll(/\$\{([A-Za-z_]\w*):?=/g))
      writes.push({ name, kind: "default-assign" });
  return writes;
}

// `set` rebinds the positional parameters with `--` or any word that is not
// an option or the argument of an `-o`/`+o` option.
function setsPositionals(operands) {
  for (let index = 0; index < operands.length; index += 1) {
    const { value, dynamic } = operands[index];
    if (dynamic || value === "--" || !/^[-+]/.test(value)) return true;
    if (/o$/.test(value)) index += 1;
  }
  return false;
}

// One lexical scope: a run block or a substitution inside one, with its
// statement tree, simple commands by first token index and child scopes.
// Offsets are absolute in the outermost run.
function lexicalScope(run, offset = 0, outer = null) {
  const lexed = shellTokens(run);
  const tree = lexed.errors.length ? null : shellTree(lexed.tokens);
  const scope = { run, offset, outer, lexed, tree, nodes: new Map(), children: [] };
  for (const node of treeNodes(tree)) {
    if (node.kind !== "simple") continue;
    const first = node.command.words[0] ?? node.command.assignments[0]?.token;
    if (first) scope.nodes.set(first.index, node);
  }
  for (const substitution of lexed.substitutions) {
    const start = substitution.index + (run[substitution.index] === "`" ? 1 : 2);
    scope.children.push({
      index: substitution.index,
      scope: lexicalScope(substitution.run, offset + start, scope),
    });
  }
  return scope;
}

const rootOf = (scope) => (scope.outer ? rootOf(scope.outer) : scope);
const scopesOf = (scope) => [scope, ...scope.children.flatMap(({ scope: child }) => scopesOf(child))];

// The simple command node in `scope` whose words or redirects own the
// character at `index` (a substitution site), or null.
function ownerNode(scope, index) {
  for (const node of scope.nodes.values()) {
    const { words, assignments, redirects } = node.command;
    const spans = [
      ...words.map((word) => [word.index, word.index + word.raw.length]),
      ...assignments.map(({ token }) => [token.index, token.index + token.raw.length]),
      ...redirects.flatMap(({ target }) => {
        if (!target) return [];
        const spans = [[target.index, target.index + target.raw.length]];
        if (typeof target.body === "string") {
          const at = scope.run.indexOf(target.body, target.index);
          if (at >= 0) spans.push([at, at + target.body.length]);
        }
        return spans;
      }),
    ];
    if (spans.some(([start, end]) => start <= index && index < end)) return node;
  }
  for (const node of treeNodes(scope.tree)) {
    if (node.kind === "for" && node.items?.some((word) => word.index <= index && index < word.index + word.raw.length))
      return node;
    if (
      node.kind === "case" &&
      node.subject &&
      node.subject.index <= index &&
      index < node.subject.index + node.subject.raw.length
    )
      return node;
  }
  return null;
}

// Whole-run analysis shared by every site in one run block: the writer
// inventory over every scope (function bodies, substitutions, here-document
// substitutions), function definitions and calls.
function runAnalysis(root) {
  if (root.analysis) return root.analysis;
  const writers = new Map();
  const definitions = new Map();
  const calls = new Map();
  let opaque = !root.tree;
  for (const scope of scopesOf(root)) {
    if (!scope.tree) opaque = true;
    for (const node of treeNodes(scope.tree)) {
      if (node.kind === "function") {
        if (!definitions.has(node.name)) definitions.set(node.name, []);
        definitions.get(node.name).push({ scope, node });
      }
      if (node.kind === "for") {
        if (!writers.has(node.name)) writers.set(node.name, []);
        writers.get(node.name).push({ name: node.name, kind: "for", scope, node });
      }
      if (node.kind !== "simple") continue;
      const selector = node.command.words[0]?.dynamic ? null : node.command.words[0]?.value;
      if (selector) {
        if (!calls.has(selector)) calls.set(selector, []);
        calls.get(selector).push({ scope, node });
      }
      for (const write of commandWrites(node.command)) {
        if (write.kind === "opaque" || write.name === null) {
          opaque = true;
          continue;
        }
        if (!writers.has(write.name)) writers.set(write.name, []);
        writers.get(write.name).push({ ...write, scope, node });
      }
      // Trap and eval actions run at other points: every name their pinned
      // text writes gets a non-dominating `deferred` writer.
      if (["trap", "eval"].includes(selector) && node.command.words[1] && !node.command.words[1].dynamic) {
        const action = lexicalScope(node.command.words[1].value);
        if (!action.tree) opaque = true;
        for (const inner of scopesOf(action))
          for (const actionNode of treeNodes(inner.tree)) {
            if (actionNode.kind !== "simple") continue;
            for (const write of commandWrites(actionNode.command)) {
              if (write.kind === "opaque" || write.name === null) opaque = true;
              else {
                if (!writers.has(write.name)) writers.set(write.name, []);
                writers.get(write.name).push({ ...write, kind: "deferred", scope: inner, node: actionNode });
              }
            }
          }
      }
    }
  }
  for (const [name, list] of definitions)
    for (const { node } of list)
      if ((calls.get(name) ?? []).some(({ node: call }) => enclosingFunction(call) === node)) opaque = true;
  if (/\bexport\s+-f\b|\bdeclare\s+-[a-zA-Z]*f/.test(root.run)) opaque = true;
  root.analysis = { writers, definitions, calls, opaque };
  return root.analysis;
}

function enclosingFunction(node) {
  let current = node?.parent;
  while (current && current.kind !== "function") current = current.parent;
  return current ?? null;
}

// The nearest enclosing loop or function boundary node.
function enclosing(node, kinds) {
  let current = node?.parent;
  while (current && !kinds.includes(current.kind)) current = current.parent;
  return current ?? null;
}

// Runner-captured roots: absolute paths the runner or shell sets, never
// option-shaped ($! and $$ are leadOf "process"). Declaring one in env voids
// the root.
const capturedRoots = new Set(["RUNNER_TEMP", "GITHUB_WORKSPACE", "GITHUB_STEP_SUMMARY", "PWD"]);
// The enumerated fixed-shape GitHub event/commit fields (#9003 LC clause):
// provenance (L4-T/LX), never a lead proof. Every other github.* root,
// including PR title/body/ref names and wildcard event fields, refuses.
const githubProvenance = new Set([
  "github.sha",
  "github.event.merge_group.head_sha",
  "github.event.pull_request.head.sha",
]);

// The roots of a GitHub expression body: each `||` alternative must be one
// enumerated context path or a quoted literal. Returns { roots, inputs } or
// null when any alternative is a secret, input outside a guard, unknown
// event field, function or operator.
function expressionRoots(body) {
  const alternatives = body.split("||").map((part) => part.trim());
  const roots = [];
  const inputs = [];
  for (const alternative of alternatives) {
    if (/^'[^']*'$/.test(alternative)) {
      if (alternatives.length === 1 || alternative.startsWith("'-")) return null;
      roots.push(alternative === "''" ? "''" : alternative);
      continue;
    }
    if (/^(?:needs\.[\w-]+|steps\.[\w-]+)\.outputs\.[\w-]+$/.test(alternative)) roots.push(alternative);
    else if (/^vars\.\w+$/.test(alternative)) roots.push(alternative);
    else if (/^job\.(?:status|container\.id|services\.[\w-]+\.id)$/.test(alternative)) roots.push(alternative);
    else if (githubProvenance.has(alternative)) roots.push(alternative);
    else if (/^(?:inputs|github\.event\.inputs)\.[\w-]+$/.test(alternative)) inputs.push(alternative);
    else return null;
  }
  if (inputs.length && (inputs.length !== 1 || alternatives.length !== 1)) return null;
  return { roots, inputs };
}

// The leading segment of a word or assignment value after quote removal.
function leadOf(text) {
  if (!text) return { kind: "empty" };
  if (text.startsWith("${{")) {
    const end = text.indexOf("}}");
    return end < 0
      ? { kind: "unsupported" }
      : { kind: "expression", body: text.slice(3, end).trim(), rest: text.slice(end + 2) };
  }
  if (text.startsWith("$((")) return { kind: "unsupported" };
  if (text.startsWith("$(") || text.startsWith("`")) {
    const end = text.startsWith("`") ? text.indexOf("`", 1) : shellGroupEnd(text, 1);
    return { kind: "substitution", rest: text.slice(end + 1), text: text.slice(0, end + 1) };
  }
  let match = text.match(/^\$\{([A-Za-z_]\w*)\[@\]\}/);
  if (match) return { kind: "array", name: match[1], rest: text.slice(match[0].length) };
  match = text.match(/^\$\{([A-Za-z_]\w*)\}/) ?? text.match(/^\$([A-Za-z_]\w*)/);
  if (match) return { kind: "name", name: match[1], rest: text.slice(match[0].length) };
  if (/^\$(?:\$|!|\{\$\}|\{!\})/.test(text))
    return { kind: "process", rest: text.replace(/^\$(?:\$|!|\{\$\}|\{!\})/, "") };
  match = text.match(/^\$([1-9])/) ?? text.match(/^\$\{([1-9])\}/);
  if (match) return { kind: "positional", position: Number(match[1]), rest: text.slice(match[0].length) };
  if (text.startsWith("$")) return { kind: "unsupported" };
  return { kind: "literal", safe: !text.startsWith("-") };
}

const refused = (reason) => ({ proved: false, reason });
const leadProof = (premise, dependencies = []) => ({ proved: true, lead: true, premise, dependencies, residual: [] });
const provenanceProof = (premise, residual, dependencies = []) => ({
  proved: true,
  lead: false,
  premise,
  dependencies,
  residual,
});
// A proof that keeps every constituent: lead only when all are lead.
function joined(premise, proofs) {
  const refusal = proofs.find((proof) => !proof.proved);
  if (refusal) return refusal;
  const dependencies = proofs.flatMap((proof) => proof.dependencies);
  const residual = proofs.flatMap((proof) => proof.residual);
  return proofs.every((proof) => proof.lead)
    ? leadProof(premise, dependencies)
    : provenanceProof(premise, residual, dependencies);
}

// A use site: the scope and statement-tree node of the command that reads the
// name, or the binding whose value reads it.
function siteOf(scope, node) {
  return { scope, node };
}

// Lifts a site inside a substitution to the command owning that substitution
// in the enclosing scope.
function liftSite(site) {
  const { scope } = site;
  if (!scope.outer) return null;
  const child = scope.outer.children.find((entry) => entry.scope === scope);
  const owner = child && ownerNode(scope.outer, child.index);
  return owner ? siteOf(scope.outer, owner) : null;
}

// Proves the lead of `text` (a word value or assignment value) at `site`.
function proveText(text, site, context, seen) {
  const lead = leadOf(text);
  switch (lead.kind) {
    case "literal":
      return lead.safe ? leadProof("L1") : refused("option-shaped literal lead");
    case "process":
      return leadProof("L3");
    case "expression": {
      const roots = expressionRoots(lead.body);
      if (!roots || roots.inputs.length) return refused(`unproved expression root ${lead.body}`);
      // Every name the suffix expands is separately proved at the site.
      const suffix = [...lead.rest.matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)].map(([, name]) => name);
      if (/[`]|\$\(|\$\{\{|\$[^A-Za-z_{]/.test(lead.rest)) return refused("unsupported expression suffix");
      const proofs = suffix.map((name) => (site ? proveName(name, site, context, seen) : refused("unsited suffix")));
      const own = provenanceProof("LX", [`\${{ ${lead.body} }}`], roots.roots);
      const failed = proofs.find((proof) => !proof.proved);
      return (
        failed ?? { ...own, dependencies: [...own.dependencies, ...proofs.flatMap((proof) => [...proof.dependencies])] }
      );
    }
    case "substitution":
      return substitutionProof(lead.text, site, context, seen);
    case "name": {
      const proof = proveName(lead.name, site, context, seen);
      if (!proof.proved || !proof.nullable) return proof;
      if (!lead.rest) return proof.nonemptyUse ? proof : refused(`${lead.name} may be empty`);
      return joined(proof.premise, [proof, proveText(lead.rest, site, context, seen)]);
    }
    default:
      return refused(`unsupported lead ${text.slice(0, 24)}`);
  }
}

// BS: `$(basename "$X")` whose input X is one proved binding ending in a
// nonempty literal non-option component. Otherwise an admitted command
// substitution proves provenance (L3-T).
function substitutionProof(text, site, context, seen) {
  const scope = scopeAt(site.scope, text);
  const basenameCall = text.match(/^\$\(basename "\$\{?([A-Za-z_]\w*)\}?"\)$/);
  if (basenameCall && !runAnalysis(rootOf(site.scope)).definitions.has("basename")) {
    const writers = runAnalysis(rootOf(site.scope)).writers.get(basenameCall[1]) ?? [];
    const value = writers.length === 1 && writers[0].kind === "assign" ? writers[0].assignment.value : "";
    const component = value.match(/\/([^/$`"'\\\n*?[]+)$/)?.[1];
    const input = component && !component.startsWith("-") ? proveName(basenameCall[1], site, context, seen) : null;
    if (input?.proved) return leadProof("BS", [basenameCall[1], ...input.dependencies]);
  }
  if (!scope) return refused("unlocated substitution");
  return substitutionAdmitted(scope, context, seen)
    ? provenanceProof("L3-T", [text], [])
    : refused("unadmitted substitution output");
}

// The child scope of `scope` whose substitution text is `text` and that the
// site's command owns.
function scopeAt(scope, text) {
  const body = text.startsWith("`") ? text.slice(1, -1) : text.slice(2, -1);
  return scope.children.find((child) => child.scope.run === body)?.scope ?? null;
}

// The origin witness a substitution scope carries: only the proved
// occurrence substitution of a run that is exactly a witness block.
function witnessOccurrence(scope) {
  const witness = scope.outer && !scope.outer.outer ? runOriginWitness(scope.outer.run) : null;
  const child = witness && scope.outer.children.find((entry) => entry.scope === scope);
  return child?.index === witness?.occurrence ? witness : null;
}
// Every command in the substitution scope (and its nested substitutions)
// classifies as admitted benign or non-destructive HANDLED at its own site.
function substitutionAdmitted(scope, context, seen) {
  if (!scope.tree || !context.grammar) return false;
  for (const inner of scopesOf(scope)) {
    if (!inner.tree) return false;
    for (const node of inner.nodes.values()) {
      if (!node.command.words.length) continue;
      const command = resolveCommandWords(node.command, commandsFromTokens(inner.lexed.tokens), inner.lexed.tokens);
      // Admission proofs stay out of the caller's trace: the substitution's
      // own commands are classified, and traced, where they stand.
      const result = classifyCommand(command, context.grammar, {
        ...context,
        origin: witnessOccurrence(inner),
        site: siteOf(inner, node),
        trace: { unsited: false, proofs: [] },
        seen,
      });
      if (result && (result.operation || result.disposition === "INDETERMINATE")) return false;
    }
  }
  return true;
}

const envScopes = ["step", "job", "workflow"];

// The innermost env declaration of `name`: { scope, value } or null.
function declaration(name, env) {
  for (const scope of envScopes) {
    const declared = env?.[scope];
    if (declared && typeof declared === "object" && Object.hasOwn(declared, name))
      return { scope, value: String(declared[name] ?? "") };
  }
  return null;
}

// An unwritten name: env-declared literal (L4-L) or trusted expression root
// (L4-T), a guarded input root (L3-G) or a captured runner root (L4).
// Declared values are read as written, not as effective values: R owns
// overrides.
function proveDeclared(name, site, context) {
  const declared = declaration(name, context.env);
  if (!declared) {
    if (capturedRoots.has(name)) return leadProof("L4", [name]);
    return refused(`undeclared ${name}`);
  }
  if (capturedRoots.has(name) || name === "PATH" || name === "TMPDIR")
    return refused(`${name} declaration voids its root`);
  const { value } = declared;
  if (!value.startsWith("${{")) {
    if (!value) return refused(`${name} is declared empty`);
    return value.startsWith("-") ? refused(`${name} literal is option-shaped`) : leadProof("L4-L", [name]);
  }
  const end = value.indexOf("}}");
  if (end < 0) return refused(`${name} expression is unterminated`);
  const roots = expressionRoots(value.slice(3, end).trim());
  if (!roots) return refused(`${name} has an unproved expression root`);
  const rest = value.slice(end + 2);
  if (roots.inputs.length) {
    if (rest) return refused(`${name} input is not the whole declaration`);
    return guardedInput(name, site, context);
  }
  const proof = provenanceProof("L4-T", [`${name}=${value}`], [name, ...roots.roots]);
  return roots.roots.includes("''") ? { ...proof, nullable: true, nonemptyUse: false } : proof;
}

// L3-G: an unwritten input-rooted name used only after a dominating
// whole-language guard whose every nonempty accepted string has a safe lead.
// A nullable language additionally needs a nonempty-use condition.
function guardedInput(name, site, context) {
  const root = rootOf(site.scope);
  const use = liftToRoot(site);
  if (!use) return refused(`${name} guard cannot reach the use`);
  for (const node of treeNodes(root.tree)) {
    if (node.kind !== "statement") continue;
    const guard = guardOf(node, name, root);
    if (!guard || !dominates(node, use.node)) continue;
    if (guard.language.dash) return refused(`${name} guard accepts an option lead`);
    if (!guard.language.nullable) return leadProof("L3-G", [name]);
    return nonemptyUse(name, use.node)
      ? leadProof("L3-G", [name])
      : { ...leadProof("L3-G", [name]), nullable: true, nonemptyUse: false };
  }
  return refused(`${name} has no dominating whole-language guard`);
}

// The site lifted through substitutions to the root scope.
function liftToRoot(site) {
  let current = site;
  while (current && current.scope.outer) current = liftSite(current);
  return current;
}

// A simple command that always exits nonzero: `exit N` (N a literal >= 1) or
// a call to a once-defined function whose body group ends in one.
function exitsNonzero(node, root, depth = 0) {
  if (node?.kind !== "simple" || depth > 1) return false;
  const words = node.command.words;
  if (literal(words[0], "exit")) return words.length === 2 && !words[1].dynamic && /^[1-9]\d*$/.test(words[1].value);
  const helper = !words[0]?.dynamic && runAnalysis(root).definitions.get(words[0]?.value);
  return (
    helper?.length === 1 &&
    helper[0].node.body.kind === "group" &&
    endsWithExit(helper[0].node.body.body, root, depth + 1)
  );
}

// The list's last statement unconditionally exits nonzero.
const endsWithExit = (list, root, depth = 0) => {
  const last = list?.items.at(-1);
  return Boolean(last) && last.chain.length === 1 && exitsNonzero(unconditionalSimple(last), root, depth);
};

// `[[ "$N" =~ RE ]] || <exit>` or `if ! [[ "$N" =~ RE ]]; then ... <exit>; fi`.
function guardOf(statement, name, root) {
  const test = (pipeline, negated) => {
    const [element] = pipeline.elements;
    if (pipeline.elements.length !== 1 || pipeline.negated !== negated || element.kind !== "simple") return null;
    const words = element.command.words;
    const subject = words[1];
    if (words.length !== 5 || !literal(words[0], "[[") || !literal(words[2], "=~") || !literal(words[4], "]]"))
      return null;
    if (!subject?.quoted || !new RegExp(`^"\\$(?:${name}|\\{${name}\\})"$`).test(subject.raw)) return null;
    if (words[3].quoted || words[3].dynamic) return null;
    return regexLanguage(words[3].value);
  };
  const [first, second] = statement.chain;
  if (statement.chain.length === 2 && second.operator === "||" && !statement.async) {
    const language = test(first.pipeline, false);
    const [handler] = second.pipeline.elements;
    if (!language || second.pipeline.elements.length !== 1 || second.pipeline.negated) return null;
    const exits = handler.kind === "group" ? endsWithExit(handler.body, root) : exitsNonzero(handler, root);
    return exits ? { language } : null;
  }
  const command = unconditionalSimple(statement);
  if (statement.chain.length !== 1 || command?.kind !== "if" || command.clauses.length !== 1 || command.otherwise)
    return null;
  const [{ condition, body }] = command.clauses;
  if (condition.items.length !== 1 || condition.items[0].chain.length !== 1) return null;
  const language = test(condition.items[0].chain[0].pipeline, true);
  return language && endsWithExit(body, root) ? { language } : null;
}

// A use inside the then-arm of `if [ -n "$N" ]` / `[[ -n "$N" ]]`.
function nonemptyUse(name, node) {
  let current = node;
  while (current) {
    if (current.kind === "list" && current.role === "then" && current.parent.kind === "if") {
      const clause = current.parent.clauses.find(({ body }) => body === current);
      const [statement] = clause.condition.items;
      const test =
        clause.condition.items.length === 1 && statement.chain.length === 1 && unconditionalSimple(statement);
      const words = test?.kind === "simple" ? test.command.words : [];
      const quotedName = new RegExp(`^"\\$(?:${name}|\\{${name}\\})"$`);
      if (
        (words.length === 4 &&
          literal(words[0], "[") &&
          literal(words[1], "-n") &&
          quotedName.test(words[2].raw) &&
          literal(words[3], "]")) ||
        (words.length === 4 &&
          literal(words[0], "[[") &&
          literal(words[1], "-n") &&
          quotedName.test(words[2].raw) &&
          literal(words[3], "]]"))
      )
        return true;
    }
    current = current.parent;
  }
  return false;
}

// Whole-language first-character analysis of an anchored POSIX ERE: `dash`
// when a nonempty accepted string may begin with `-`, `nullable` when the
// empty string is accepted. Unanchored, top-level alternation, interior
// anchors and unsupported syntax refuse as `dash`.
function regexLanguage(pattern) {
  const unsafe = { dash: true, nullable: true };
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.endsWith("\\$")) return unsafe;
  const body = pattern.slice(1, -1);
  let index = 0;
  const atom = () => {
    const character = body[index];
    if (character === "(") {
      index += 1;
      const inner = alternation();
      if (body[index] !== ")") throw new Error("unbalanced group");
      index += 1;
      return inner;
    }
    if (character === "[") {
      const end = body.indexOf("]", index + (body[index + 1] === "^" ? 3 : 2));
      if (end < 0) throw new Error("unterminated bracket");
      const set = body.slice(index + 1, end);
      // Character classes and collating elements are not parsed: refuse.
      if (set.includes("[")) throw new Error("unsupported bracket expression");
      index = end + 1;
      if (set.startsWith("^")) return { dash: !set.slice(1).includes("-"), nullable: false };
      const ranges = [...set.matchAll(/(.)-(.)/g)].some(([, low, high]) => low <= "-" && "-" <= high);
      return { dash: set.startsWith("-") || set.endsWith("-") || ranges, nullable: false };
    }
    if (character === "\\") {
      index += 2;
      return { dash: body[index - 1] === "-", nullable: false };
    }
    if (character === ".") {
      index += 1;
      return { dash: true, nullable: false };
    }
    if (character === undefined || "|)^$*+?{".includes(character)) throw new Error("unsupported atom");
    index += 1;
    return { dash: character === "-", nullable: false };
  };
  const quantified = () => {
    let node = atom();
    for (;;) {
      const character = body[index];
      if (character === "?" || character === "*") {
        node = { dash: node.dash, nullable: true };
        index += 1;
      } else if (character === "+") index += 1;
      else if (character === "{") {
        const match = body.slice(index).match(/^\{(\d+)(,\d*)?\}/);
        if (!match) throw new Error("unsupported bound");
        if (Number(match[1]) === 0) node = { dash: node.dash, nullable: true };
        index += match[0].length;
      } else return node;
    }
  };
  const sequence = () => {
    let node = { dash: false, nullable: true };
    while (index < body.length && body[index] !== "|" && body[index] !== ")") {
      const next = quantified();
      node = { dash: node.dash || (node.nullable && next.dash), nullable: node.nullable && next.nullable };
    }
    return node;
  };
  const alternation = () => {
    let node = sequence();
    while (body[index] === "|") {
      index += 1;
      const next = sequence();
      node = { dash: node.dash || next.dash, nullable: node.nullable || next.nullable };
    }
    return node;
  };
  try {
    let topLevel = 0;
    for (let position = 0, depth = 0; position < body.length; position += 1) {
      if (body[position] === "\\") position += 1;
      else if (body[position] === "(") depth += 1;
      else if (body[position] === ")") depth -= 1;
      else if (body[position] === "|" && depth === 0) topLevel += 1;
    }
    if (topLevel) return unsafe;
    const language = alternation();
    return index === body.length ? language : unsafe;
  } catch {
    return unsafe;
  }
}

// Proves name `name` read at `site`.
function proveName(name, site, context, seen = new Set()) {
  if (seen.has(name)) return refused(`cyclic binding of ${name}`);
  const next = new Set(seen).add(name);
  const root = rootOf(site.scope);
  const analysis = runAnalysis(root);
  if (analysis.opaque) return refused("opaque, nameref, recursive or unsupported writer in run");
  // A function that declares `local NAME` scopes its own writes of NAME to its
  // invocation: they never reach a use outside that function.
  const all = analysis.writers.get(name) ?? [];
  const scoping = new Set(all.filter(({ kind }) => kind === "local").map(({ node }) => enclosingFunction(node)));
  const useFunction = enclosingFunction(liftToRoot(site)?.node ?? site.node);
  const writers = all.filter(({ node }) => {
    const owner = enclosingFunction(node);
    return !owner || !scoping.has(owner) || owner === useFunction;
  });
  if (!writers.length && all.length) return refused(`${name} is bound only in other function scopes`);
  if (!writers.length) return proveDeclared(name, site, context);
  const use = useNode(site, writers);
  if (!use) return refused(`${name} use is outside every binding scope`);
  const [writer] = writers;
  if (writers.length === 1 && writer.kind === "read") return readTarget(name, writer, use, context, next);
  if (writers.length === 1 && writer.kind === "for") return iterator(writer, use, context, next);
  if (writers.length === 1 && writer.kind === "local") return localBinding(name, writer, use, context, next);
  if (writers.every(({ kind }) => kind === "assign")) return plainBindings(name, writers, use, context, next);
  return refused(`${name} has an unsupported writer set (${writers.map(({ kind }) => kind).join(", ")})`);
}

// The use as a node in the scope that holds every writer: the site itself,
// or the site lifted through substitutions to the enclosing scope.
function useNode(site, writers) {
  let current = site;
  while (current) {
    if (writers.every((writer) => writer.scope === current.scope)) return current;
    current = liftSite(current);
  }
  return null;
}

// The writer statement dominates the use, and every function body crossed
// between them is defined exactly once.
function dominatedUse(writerStatement, use, root) {
  if (!writerStatement || !dominates(writerStatement, use.node)) return false;
  for (let current = use.node.parent; current && current !== writerStatement.list; current = current.parent)
    if (current.kind === "function" && runAnalysis(root).definitions.get(current.name)?.length !== 1) return false;
  return true;
}

// The statement whose lone unconditional element is the writer's command.
function writerStatement(writer) {
  const statement = statementOf(writer.node);
  return statement && unconditionalSimple(statement) === writer.node ? statement : null;
}

const loopOf = (node) => enclosing(node, ["for", "while", "until"]);

// One or more plain scalar assignments of `name`.
function plainBindings(name, writers, use, context, seen) {
  const root = rootOf(use.scope);
  const statements = writers.map(writerStatement);
  if (statements.some((statement) => !statement)) return refused(`${name} binding is not a lone statement`);
  const owners = new Set(writers.map(({ node }) => enclosingFunction(node)).filter(Boolean));
  if ([...owners].some(({ name: owner }) => runAnalysis(root).definitions.get(owner)?.length !== 1))
    return refused(`${name} is bound in a redefined function`);
  const proofs = writers.map((writer) =>
    proveText(writer.assignment.value, siteOf(writer.scope, writer.node), context, seen),
  );
  if (writers.length > 1) return conditionalBindings(name, statements, proofs, use, context);
  const [statement] = statements;
  const [proof] = proofs;
  if (!dominatedUse(statement, use, root)) return refused(`${name} binding does not dominate its use`);
  if (!proof.proved) return proof;
  const { role, parent: owner } = statement.list;
  if (role === "root") return { ...proof, premise: use.scope === root ? "L3" : "LS" };
  if (owner.kind === "for") {
    if (!finiteIterator(owner, use.scope, context, seen)) return refused(`${name} loop is not a finite literal loop`);
    return proof.lead ? { ...proof, premise: "LB" } : refused(`${name} loop binding proves provenance only`);
  }
  if (owner.kind === "while" && role === "body") {
    const header = readLoop(owner);
    if (!header || header.ifs !== "IFS=" || header.targets.length !== 1)
      return refused(`${name} loop header is not LI`);
    return proof.premise === "L3-T" || proof.premise === "LI"
      ? { ...proof, premise: "LI" }
      : refused(`${name} read-loop binding is not admitted output`);
  }
  if (["then", "else", "arm", "group"].includes(role)) return { ...proof, premise: "LS" };
  return refused(`${name} binding context is unsupported`);
}

// LC / LC-B: an initial binding that dominates the use (one unconditional
// statement, or an exhaustive if/elif/else binding once per arm) plus finite
// replacements at the arm level of later if statements in the same list.
// Every writer is proved; the union keeps the writers that can reach the use.
// A replacement after the use, or in the if whose condition holds the use,
// cannot reach it: the initial binding precedes the use on every path.
function conditionalBindings(name, statements, proofs, use, context) {
  const root = rootOf(use.scope);
  const armBound = (holder) =>
    holder?.kind === "if" &&
    holder.otherwise &&
    [...holder.clauses.map(({ body }) => body), holder.otherwise].every(
      (arm) => statements.filter((statement) => statement.list === arm).length === 1,
    );
  const single = statements.filter((statement) => dominatedUse(statement, use, root));
  const holders = [...new Set(statements.map((statement) => statement.list.parent))].filter(
    (holder) => armBound(holder) && dominatedUse(statementOf(holder), use, root),
  );
  let base;
  let initial;
  if (single.length === 1 && !holders.length) {
    [base] = single;
    initial = [base];
  } else if (!single.length && holders.length === 1) {
    base = statementOf(holders[0]);
    initial = statements.filter((statement) => statement.list.parent === holders[0]);
  } else return refused(`${name} has no single initial binding`);
  const reaching = [...initial];
  for (const statement of statements) {
    if (initial.includes(statement)) continue;
    const holder = statement.list.parent;
    const holderStatement =
      holder?.kind === "if" && ["then", "else"].includes(statement.list.role) && statementOf(holder);
    if (!holderStatement || holderStatement.list !== base.list || holderStatement.index <= base.index)
      return refused(`${name} has an unsupported replacement`);
    const useStatement = statementIn(base.list, use.node);
    if (dominatedUse(holderStatement, use, root)) reaching.push(statement);
    else if (useStatement !== holderStatement && useStatement.index < holderStatement.index) continue;
    else if (
      useStatement === holderStatement &&
      holder.clauses.some(({ condition }) => statementIn(condition, use.node))
    )
      continue;
    else return refused(`${name} replacement may reach its use inside the conditional`);
  }
  const loop = base.list.parent;
  if (base.list.role === "body" && loop?.kind === "for") {
    if (!finiteIterator(loop, use.scope, context, new Set())) return refused(`${name} loop is not finite`);
    if (!proofs.every((proof) => proof.proved && proof.lead)) return refused(`${name} loop writer is not a safe lead`);
    return joined(
      "LC-B",
      proofs.filter((_, index) => reaching.includes(statements[index])),
    );
  }
  if (loopOf(base)) return refused(`${name} conditional binding is inside an unsupported loop`);
  const refusal = proofs.find((proof) => !proof.proved);
  return (
    refusal ??
    joined(
      "LC",
      proofs.filter((_, index) => reaching.includes(statements[index])),
    )
  );
}
// The literal word list or proved array of a finite `for` header.
function finiteIterator(loop, scope, context, seen) {
  if (!loop.items?.length) return false;
  if (loop.items.every((word) => !word.dynamic && !filenamePattern(word) && !word.value.startsWith("-"))) return true;
  const [item] = loop.items;
  const array = loop.items.length === 1 && item.quoted && item.raw.match(/^"\$\{([A-Za-z_]\w*)\[@\]\}"$/);
  return Boolean(array) && finiteArray(array[1], siteOf(scopeHolding(rootOf(scope), loop), loop), context, seen).proved;
}

// The scope whose tree holds `node`.
function scopeHolding(root, node) {
  for (const scope of scopesOf(root))
    for (const candidate of treeNodes(scope.tree)) if (candidate === node) return scope;
  return root;
}

// The iterator of a finite loop, read in that loop's body (LB literal words,
// LE proved array).
function iterator(writer, use, context, seen) {
  const loop = writer.node;
  if (statementIn(loop.body, use.node) === null) return refused(`${loop.name} is read outside its loop`);
  if (!loop.items?.length) return refused(`${loop.name} iterates positionals`);
  if (loop.items.every((word) => !word.dynamic && !filenamePattern(word) && !word.value.startsWith("-")))
    return leadProof("LB", [loop.name]);
  const [item] = loop.items;
  const array = loop.items.length === 1 && item.quoted && item.raw.match(/^"\$\{([A-Za-z_]\w*)\[@\]\}"$/);
  if (!array) return refused(`${loop.name} iterates an unproved list`);
  const proof = finiteArray(array[1], siteOf(writer.scope, loop), context, seen);
  return proof.proved ? { ...proof, premise: "LE", dependencies: [loop.name, ...proof.dependencies] } : proof;
}

// LE: an indexed array built once by a dominating finite constructor plus
// finite single-word appends at the arm level of later if statements, every
// element a proved safe lead.
function finiteArray(name, site, context, seen = new Set()) {
  const root = rootOf(site.scope);
  const writers = runAnalysis(root).writers.get(name) ?? [];
  const constructors = writers.filter(({ kind }) => kind === "array");
  if (constructors.length !== 1 || writers.some(({ kind }) => kind !== "array" && kind !== "array-append"))
    return refused(`${name} array has an unsupported writer`);
  const [constructor] = constructors;
  const base = writerStatement(constructor);
  if (!base || !dominates(base, site.node)) return refused(`${name} array does not dominate its use`);
  const proofs = [];
  for (const writer of writers) {
    const statement = writerStatement(writer);
    if (writer !== constructor) {
      const holder = statement?.list.parent;
      const holderStatement = holder?.kind === "if" && statementOf(holder);
      if (!holderStatement || holderStatement.list !== base.list || holderStatement.index <= base.index)
        return refused(`${name} append is unsupported`);
      if (!dominates(holderStatement, site.node)) return refused(`${name} append does not precede its use`);
    }
    for (const element of writer.assignment.array)
      proofs.push(
        variadicWord(element)
          ? refused(`${name} element may split`)
          : proveText(element.value, siteOf(writer.scope, writer.node), context, seen),
      );
  }
  const proof = joined("LE", proofs);
  return proof.proved && !proof.lead ? refused(`${name} element proves provenance only`) : proof;
}

// `while <IFS assignment> read -r TARGET...` as the whole loop condition.
function readLoop(loop) {
  if (loop.kind !== "while" || loop.condition.items.length !== 1) return null;
  const [statement] = loop.condition.items;
  const command = statement.chain.length === 1 && unconditionalSimple(statement);
  if (command?.kind !== "simple") return null;
  const { words, assignments, redirects } = command.command;
  if (redirects.length || !literal(words[0], "read") || !literal(words[1], "-r")) return null;
  if (assignments.length !== 1 || assignments[0].name !== "IFS") return null;
  return { command, ifs: assignments[0].token.raw, targets: words.slice(2) };
}

// LR: the first target N of exactly `while IFS=$'\t' read -r N T; do ... done
// <<< "${P}"`, read inside that iteration, where P is one top-level binding of
// one quoted substitution holding only an admitted gh issue list with the
// exact number,title projection. Provenance only: both fields stay residual.
function readTarget(name, writer, use, context, seen) {
  const loop = enclosing(writer.node, ["while", "until"]);
  const header = loop && readLoop(loop);
  if (!header || header.command !== writer.node) return refused(`${name} read is not a loop header`);
  if (header.ifs !== "IFS=$'\\t'" || header.targets.length !== 2) return refused(`${name} read is not the LR header`);
  const [first, second] = header.targets;
  if ([first, second].some((word) => word.dynamic || word.quoted || !nameWord.test(word.value)))
    return refused(`${name} read targets are not plain names`);
  if (first.value !== name || second.value === name) return refused(`${name} is not the first LR target`);
  if (statementIn(loop.body, use.node) === null) return refused(`${name} is read outside its iteration`);
  const root = rootOf(use.scope);
  const analysis = runAnalysis(root);
  if (analysis.definitions.has("read")) return refused("read is shadowed");
  const [input] = loop.redirects;
  const source =
    loop.redirects.length === 1 &&
    input.operator === "<<<" &&
    input.target?.raw.match(/^"\$\{?([A-Za-z_]\w*)\}?"$|^\$([A-Za-z_]\w*)$/);
  const producerName = source && (source[1] ?? source[2]);
  if (!producerName || producerName === name || producerName === second.value)
    return refused(`${name} loop input is unsupported`);
  if ((analysis.writers.get(second.value) ?? []).length !== 1) return refused(`${second.value} has another writer`);
  const producers = analysis.writers.get(producerName) ?? [];
  if (producers.length !== 1 || producers[0].kind !== "assign" || producers[0].scope !== root)
    return refused(`${producerName} has another writer`);
  const [producer] = producers;
  const statement = writerStatement(producer);
  if (statement?.list.role !== "root" || !dominates(statement, loop))
    return refused(`${producerName} is not one top-level binding before the loop`);
  const raw = producer.assignment.token.raw.slice(producer.assignment.token.raw.indexOf("=") + 1);
  const scope = /^"\$\([\s\S]*\)"$/.test(raw) && scopeAt(root, producer.assignment.value);
  if (!scope?.tree || scope.children.length || scope.tree.items.length !== 1)
    return refused(`${producerName} is not one quoted substitution of one command`);
  const [producerStatement] = scope.tree.items;
  const element = producerStatement.chain.length === 1 && unconditionalSimple(producerStatement);
  if (element?.kind !== "simple" || element.command.redirects.length || element.command.assignments.length)
    return refused(`${producerName} producer is not one plain command`);
  const words = element.command.words;
  const jq = words.findIndex((word) => literal(word, "--jq"));
  const json = words.findIndex((word) => literal(word, "--json"));
  const filter = words[jq + 1];
  const projection =
    jq >= 0 &&
    filter.quoted &&
    !filter.dynamic &&
    /^\.\[\] \| select\(\.title \| startswith\("[^"\\]*"\)\) \| \[\.number, \.title\] \| @tsv$/.test(filter.value);
  if (!literal(words[0], "gh") || !literal(words[1], "issue") || !literal(words[2], "list"))
    return refused(`${producerName} producer is not gh issue list`);
  if (json < 0 || !literal(words[json + 1], "number,title") || !projection)
    return refused(`${producerName} producer projection is not the LR form`);
  if (words.filter((word) => ["--jq", "--json"].includes(word.value)).length !== 2)
    return refused(`${producerName} producer repeats a projection option`);
  const admitted = classifyCommand(element.command, context.grammar, {
    ...context,
    site: siteOf(scope, element),
    seen,
  });
  if (admitted) return refused(`${producerName} producer is not admitted`);
  return provenanceProof("LR", [`${producerName}: gh issue list .number`], [name, producerName, ".number", ".title"]);
}

// LL / LP: `local NAME=value` alone at its function body's statement level,
// dominating the use; a "$n" value inherits every direct call's nth actual.
function localBinding(name, writer, use, context, seen) {
  const root = rootOf(use.scope);
  const statement = writerStatement(writer);
  const functionNode = enclosingFunction(writer.node);
  if (!statement || !functionNode || functionNode.body.kind !== "group" || statement.list !== functionNode.body.body)
    return refused(`${name} local is not at function statement-list level`);
  const declarations = writer.node.command.words.slice(1);
  if (writer.value === null || declarations.some((word) => word.dynamic && !/^[A-Za-z_]\w*=/.test(word.raw)))
    return refused(`${name} local is not a plain binding`);
  if (!dominates(statement, use.node)) return refused(`${name} local does not dominate its use`);
  if (runAnalysis(root).definitions.get(functionNode.name)?.length !== 1)
    return refused(`${functionNode.name} is redefined`);
  const positional = writer.word.raw.match(/^[A-Za-z_]\w*="\$\{?([1-9])\}?"$/);
  if (positional) return positionalActuals(functionNode, Number(positional[1]), root, context, seen);
  const proof = proveText(writer.value, siteOf(writer.scope, writer.node), context, seen);
  if (!proof.proved) return proof;
  return proof.lead ? { ...proof, premise: "LL" } : refused(`${name} local proves provenance only`);
}

// LP: the nth single-word actual of every direct same-run call, each proved a
// safe lead at its own call site; positional rebinding refuses.
function positionalActuals(functionNode, position, root, context, seen) {
  const analysis = runAnalysis(root);
  if (analysis.writers.has("@positional")) return refused("positional parameters are rebound");
  const calls = analysis.calls.get(functionNode.name) ?? [];
  if (!calls.length) return refused(`${functionNode.name} has no direct call`);
  const proofs = calls.map(({ scope, node }) => {
    const words = node.command.words;
    if (words.slice(1, position + 1).some((word) => !word || variadicWord(word)))
      return refused("missing or variadic actual");
    const actual = words[position];
    if (!actual.dynamic) return actual.value.startsWith("-") ? refused("option-shaped actual") : leadProof("L1");
    return proveText(actual.value, siteOf(scope, node), context, seen);
  });
  const proof = joined("LP", proofs);
  return proof.proved && !proof.lead ? refused("positional actual proves provenance only") : proof;
}

// The F4 lead proof for `word` at the context's site. The shared trace
// records an unsited attempt (a stored entry needs its origin) and every
// proof, whose premise and residual feed the R handoff inventory.
function proveOperand(word, context) {
  if (variadicWord(word)) return false;
  // Literal, expression and process leads need no binding, hence no site.
  const lead = leadOf(word.value);
  const sitelessLead =
    ["literal", "process"].includes(lead.kind) || (lead.kind === "expression" && !/[$`]/.test(lead.rest));
  if (!context?.site && !sitelessLead) {
    if (context?.trace) context.trace.unsited = true;
    return false;
  }
  const proof = proveText(word.value, context?.site ?? null, context ?? {}, context?.seen ?? new Set());
  const proved = proof.proved && !(proof.nullable && !proof.nonemptyUse);
  context?.trace?.proofs.push({
    entry: context.entry,
    word: word.raw ?? word.value,
    index: word.index,
    ...proof,
    proved,
  });
  return proved;
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
// One argument that cannot begin with `-`: a literal that is not option-shaped,
// or a protected expansion behind a fixed non-option lead. A leading expansion
// may yield an option.
const nonOptionWord = (word) =>
  singleArgument(word) &&
  (word.dynamic ? /^[^-$`]/.test(word.value) : word.value === "-" || !word.value.startsWith("-"));
// Every occurrence of the identifier `name` in `text` reads it as $name or
// ${name}, or lies inside one of the proved binding `spans` ([start, end)).
const onlyReads = (text, name, spans = []) =>
  [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g"))].every(
    ({ index }) =>
      spans.some(([start, end]) => start <= index && index < end) ||
      text[index - 1] === "$" ||
      (text.slice(index - 2, index) === "${" && text[index + name.length] === "}"),
  );

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
// `values` marks shapes whose operands are L2 data values (pinned git-config
// keys, same-block function arguments), not option-capable F4 operands. Every
// other dynamic operand needs its proved lead (proveOperand); a quoted
// "${ARRAY[@]}" operand is re-walked once per finite alternative (AV).
function terminal({ global = "", shapes = { "": "" } } = {}) {
  const globals = optionTable(global);
  const table = Object.entries(shapes).map(([path, shape]) => {
    const {
      options = "",
      operands = Infinity,
      variadic = false,
      values = false,
    } = typeof shape === "string" ? { options: shape } : shape;
    return { path: path ? path.split(" ") : [], options: optionTable(options), operands, variadic, values };
  });
  const admit = (words, at, next, context) => {
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
      } else if (variadicWord(word) && !shape.variadic) {
        const alternatives = context?.arrays === false ? null : arrayAlternatives(word, context);
        if (!alternatives) return false;
        const flat = { ...context, arrays: false };
        return alternatives.every((elements) =>
          admit([...words.slice(0, index), ...elements, ...words.slice(index + 1)], at, next, flat),
        );
      } else {
        if (!variadicWord(word) && ++operands > shape.operands) return false;
        if (word.dynamic && !variadicWord(word) && !shape.values && !proveOperand(word, context)) return false;
        index += 1;
      }
    }
    return true;
  };
  return Object.assign(admit, { global: globals, shapes: table });
}

// AV: the finite alternatives of a quoted "${NAME[@]}" operand: one
// constructor dominating the use plus single appends at the arm level of later
// if statements before it; each element a single word. Null refuses.
function arrayAlternatives(word, context) {
  const name = word.quoted && word.dynamic && word.value.match(/^\$\{([A-Za-z_]\w*)\[@\]\}$/)?.[1];
  if (!name || !context?.site) {
    if (context?.trace && name) context.trace.unsited = true;
    return null;
  }
  const root = rootOf(context.site.scope);
  const analysis = runAnalysis(root);
  if (analysis.opaque) return null;
  const writers = analysis.writers.get(name) ?? [];
  const constructors = writers.filter(({ kind }) => kind === "array");
  const appends = writers.filter(({ kind }) => kind === "array-append");
  if (constructors.length !== 1 || constructors.length + appends.length !== writers.length || appends.length > 3)
    return null;
  const use = useNode(context.site, writers);
  const base = writerStatement(constructors[0]);
  if (!use || !base || !dominatedUse(base, use, root)) return null;
  for (const writer of appends) {
    const holder = writerStatement(writer)?.list.parent;
    const holderStatement = holder?.kind === "if" && statementOf(holder);
    if (!holderStatement || holderStatement.list !== base.list || holderStatement.index <= base.index) return null;
    if (!dominatedUse(holderStatement, use, root)) return null;
  }
  const elements = [constructors[0], ...appends].map(({ assignment }) => assignment.array);
  if (elements.flat().some((element) => !singleArgument(element))) return null;
  const alternatives = [];
  for (let mask = 0; mask < 2 ** appends.length; mask += 1)
    alternatives.push([elements[0], ...appends.map((_, bit) => (mask & (2 ** bit) ? elements[bit + 1] : []))].flat());
  return alternatives;
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
// `workspace="$2"` is its only binding, that nothing in the block or in the
// substitution holding the command rebinds it or the positional parameters,
// and that boot_smoke has exactly two callers, each passing a literal package;
// "$workspace" therefore selects one of those packages only inside that exact
// text and substitution occurrence.
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
const rebinds = ({ words }) => rebindingCommands.has(words[0]?.value) || words[0]?.value === "set";

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
  // The bound substitution is its own statement scope: it must lex cleanly,
  // nest no further substitution and rebind nothing before or around the
  // command; arithmetic and nested assignments are caught by onlyReads.
  const scope = substitution && shellTokens(substitution.run);
  const scopeProved =
    Boolean(scope) &&
    !scope.errors.length &&
    !scope.substitutions.length &&
    !commandsFromTokens(scope.tokens).some(rebinds);
  const proved =
    !errors.length &&
    definitions.length === 1 &&
    bindings.length === 1 &&
    binding.token.raw === 'workspace="$2"' &&
    !tokens.some((token) => token.type === "word" && token.value === "workspace") &&
    onlyReads(run, "workspace", [[binding.token.index, binding.token.index + binding.token.raw.length]]) &&
    !rebinding &&
    scopeProved &&
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

// Origin-bound directories: the only corpus sed file operands that are
// dynamic. Each record names its corpus step, the operand and the assignment
// chain deriving its directory from a non-option root (`mktemp -d` prints an
// absolute path under TMPDIR; the runner sets RUNNER_TEMP to one), so the
// operand cannot begin with `-`. directoryWitness re-proves the chain from the
// stored text. Each root lists the names its value depends on.
const directoryRoots = new Map([
  ["$(mktemp -d)", ["mktemp", "TMPDIR"]],
  ["${RUNNER_TEMP}", ["RUNNER_TEMP"]],
]);
const originDirectories = [
  {
    origin: {
      sha: "926050f88aae70a631c117c1e0f002a3160a9278",
      path: ".github/workflows/platform-pr.yml",
      job: "terraform-preview-plan",
      step: 6,
    },
    operand: "$tmp/versions.tf",
    bindings: ['tmp="$(mktemp -d)"'],
  },
  {
    origin: {
      sha: "926050f88aae70a631c117c1e0f002a3160a9278",
      path: ".github/workflows/platform-observability-state-migration.yml",
      job: "migrate",
      step: 8,
    },
    operand: "$local_module/versions.tf",
    bindings: [
      'migration_root="${RUNNER_TEMP}/observability-state-migration"',
      'local_root="${migration_root}/local"',
      'local_module="${local_root}/infrastructure/digitalocean/observability"',
    ],
  },
]
  .map(directoryWitness)
  .filter(Boolean);

// Each binding is one plain assignment rooted at the previous name, the first
// at a listed root; the operand is a fixed path under the last name. The
// witness's names are the bound names, the root and PATH.
function directoryWitness(record) {
  const names = [];
  for (const text of record.bindings) {
    const { tokens, errors } = shellTokens(text);
    const commands = commandsFromTokens(tokens);
    const [assignment] = commands[0]?.assignments ?? [];
    const roots = names.length ? [`\${${names.at(-1)}}`] : [...directoryRoots.keys()];
    const root = roots.find((lead) => assignment?.value === lead || assignment?.value.startsWith(`${lead}/`));
    const plain =
      !errors.length &&
      commands.length === 1 &&
      commands[0].words.length === 0 &&
      commands[0].assignments.length === 1 &&
      assignment.token.raw === text;
    if (!plain || root === undefined) return null;
    if (!names.length) names.push(...directoryRoots.get(root), "PATH");
    names.push(assignment.name);
  }
  const fixed =
    record.operand.startsWith(`$${names.at(-1)}/`) && /^[\w./-]+$/.test(record.operand.slice(names.at(-1).length + 2));
  return fixed ? { ...record, names } : null;
}

// A stored entry may use the operands of directories its origin names.
const entryDirectories = (entry) =>
  originDirectories
    .filter(({ origin }) => ["sha", "path", "job", "step"].every((field) => origin[field] === entry.origin?.[field]))
    .map(({ operand }) => operand);

// The directories a run proves, each with the index its last binding ends at.
// A run proves one only when it makes each assignment exactly once, by that
// text, as an unconditional top-level statement, otherwise only reads the
// witness's names, and no step, job or workflow env declares any of them.
function runDirectories(run, tokens, env = {}) {
  // Tokens that make a later statement conditional, grouped or a subshell.
  const control = (token) =>
    token.type === "operator"
      ? !["\n", ";"].includes(token.value) && !redirections.has(token.value)
      : !token.quoted && (ambiguousAssignmentContext.test(token.value) || ["{", "}"].includes(token.value));
  const separator = (token) => !token || (token.type === "operator" && ["\n", ";"].includes(token.value));
  return originDirectories.flatMap(({ operand, bindings, names }) => {
    if (!bindings.every((text) => run.includes(text))) return [];
    const positions = [];
    for (const text of bindings) {
      const found = tokens.flatMap((token, position) =>
        token.type === "word" && token.raw === text ? [position] : [],
      );
      const [position] = found;
      const statement =
        found.length === 1 &&
        position > (positions.at(-1) ?? -1) &&
        separator(tokens[position - 1]) &&
        separator(tokens[position + 1]) &&
        !tokens.slice(0, position).some(control);
      if (!statement) return [];
      positions.push(position);
    }
    const spans = positions.map((position) => [
      tokens[position].index,
      tokens[position].index + tokens[position].raw.length,
    ]);
    if (!names.every((name) => onlyReads(run, name, spans))) return [];
    if (names.some((name) => declaration(name, env))) return [];
    return [{ operand, after: tokens[positions.at(-1)].index }];
  });
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

// find: one start path (pinned, or a dynamic path with a proved lead), then
// exactly `-type f -name <pattern>` with an optional `! -name <pattern>`; no
// action or other predicate.
function findRoles(words, at, next, context) {
  const start = words[at + 1];
  const provedStart = Boolean(start) && start.dynamic && singleArgument(start) && proveOperand(start, context);
  if (!pinnedOperand(start) && !provedStart) return false;
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

// A shell runs exactly one pinned program: `-c <pinned text>`, or one pinned
// non-option `.sh` script with no arguments, whose body is not interpreted
// here (like the other pinned script modes).
const shellProgram = (words, at) =>
  (literal(words[at + 1], "-c") && pinnedText(words[at + 2]) && words.length === at + 3) ||
  (pinnedOperand(words[at + 1]) && /\.sh$/.test(words[at + 1].value) && words.length === at + 2);
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
    if (container.dynamic && !proveOperand(container, context)) return false;
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
    if (image.dynamic && !proveOperand(image, context)) return false;
    const entrypoint = image.dynamic ? null : pinnedImages.get(image.value);
    if (!entrypoint) return next(index + 1);
    const argv = [{ value: entrypoint, dynamic: false, quoted: false }, ...words.slice(index + 1)];
    return programRules.get(entrypoint)(argv, 0, () => false, context);
  }
  // compose is its own command path: `-f <file>` precedes the pinned subcommand.
  if (literal(words[at + 1], "compose")) return composeTerminal(words, at + 1, next, context);
  return dockerTerminal(words, at, next, context);
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
function kubectlRoles(words, at, next, context) {
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
    if (resource.dynamic && !proveOperand(resource, context)) return false;
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
  return kubectlTerminal(words, at, next, context);
}

function trapRoles(words, at) {
  if (!pinnedText(words[at + 1]) || words.length < at + 3) return false;
  return words.slice(at + 2).every((signal) => !signal.dynamic && /^[A-Z][A-Z0-9]*$/.test(signal.value));
}

// A dynamic word that is the operand of a directory the context proves.
const directoryOperand = (word, context) =>
  word.dynamic && singleArgument(word) && context.directories.includes(word.value);

// awk and sed take their pinned program as the first operand after proved
// options. GNU sed permutes options, so any later word that may begin with `-`
// can add a program (-e, -f) or select another option. Later words are
// therefore files proved not to begin with `-`, origin-bound directory
// operands, or any single argument after a literal `--`, which ends options.
function programOperand(options) {
  const table = optionTable(options);
  return (words, at, next, context) => {
    let index = at + 1;
    let ended = false;
    while (!ended && literalOption(words[index])) {
      ended = literal(words[index], "--");
      index = ended ? index + 1 : optionEnd(words, index, table);
      if (index < 0) return false;
    }
    if (!pinnedText(words[index])) return false;
    for (const word of words.slice(index + 1)) {
      if (!ended && literal(word, "--")) ended = true;
      else if (!(ended ? singleArgument(word) : nonOptionWord(word) || directoryOperand(word, context))) return false;
    }
    return true;
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
// L2: a call of a function defined exactly once in the same run; its
// arguments are data values for that body, whose own operands prove leads.
const functionArguments = terminal({ shapes: { "": { values: true } } });
const workflowFunction = Object.assign(
  (words, at, next, context) => {
    if (!context?.site) {
      if (context?.trace) context.trace.unsited = true;
      return false;
    }
    const definitions = runAnalysis(rootOf(context.site.scope)).definitions.get(hopSelector(words[at]));
    return definitions?.length === 1 && functionArguments(words, at, next, context);
  },
  { global: functionArguments.global, shapes: functionArguments.shapes },
);
const programRules = new Map([
  // Prefixes and forwarders.
  ["timeout", modes("duration", timeoutPrefix)],
  ["nohup", modes("forward", (words, at, next) => next(at + 1))],
  [
    "xvfb-run",
    modes("--auto-servernum", (words, at, next) => literal(words[at + 1], "--auto-servernum") && next(at + 2)),
  ],
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
  ...[...shellInterpreters].map((name) => [name, modes("-c, script", shellProgram)]),
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
  ["vitest", terminal({ shapes: { run: "--config:1" } })],
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
        "config --global init.defaultBranch": { operands: 1, values: true },
        "config user.email": { operands: 1, values: true },
        "config user.name": { operands: 1, values: true },
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
        "issue create": "--repo:1 --title:1 --body:1 --label:1 --milestone:1",
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
  ["exit", terminal({ shapes: { "": { variadic: true, values: true } } })],
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
    "trimmed_env",
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
    rule.shapes.map(({ path, options, operands, variadic, values }) => ({
      selector,
      kind: "terminal",
      path: path.join(" "),
      global: Object.fromEntries(rule.global),
      options: Object.fromEntries(options),
      operands,
      variadic,
      values,
    }));
  return [...programRules].flatMap(([selector, rule]) => [
    ...(rule === workflowFunction ? [{ selector, kind: "function" }] : []),
    ...(rule.modes ?? []).map((mode) => ({ selector, kind: "program", mode })),
    ...(rule.terminals ?? []).flatMap(([prefix, terminalRule]) => terminalRows(prefix, terminalRule)),
    ...(rule.shapes && rule !== workflowFunction ? terminalRows(selector, rule) : []),
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
  // An origin transition keeps its immutable pre-transition record: the same
  // shape must occur there, and both run hashes are pinned. The transition
  // itself admits nothing; the proof below runs at the current origin.
  if (entry.transition) {
    const { from, beforeRunSha256, afterRunSha256 } = entry.transition;
    const before = from && originRecord(grammar, from);
    const after = originRecord(grammar, entry.origin);
    const intact =
      before &&
      after &&
      before.runSha256 === beforeRunSha256 &&
      after.runSha256 === afterRunSha256 &&
      originKey(from) !== originKey(entry.origin) &&
      originSites({ ...entry, origin: from, transition: undefined }, grammar).length > 0;
    if (!intact) return [`${entry.id}: incomplete benign form proof or corpus identity.`];
  }
  const base = { origin: entryOriginWitness(entry), directories: entryDirectories(entry), grammar };
  const trace = { unsited: false, proofs: [] };
  const stored = roleViolations(entry, entry.words, grammar, { ...base, trace });
  if (!trace.unsited) return stored;
  const sites = originSites(entry, grammar);
  return sites.length && sites.every((context) => !roleViolations(entry, context.words, grammar, context).length)
    ? []
    : [`${entry.id}: benign payload admits an unpinned program.`];
}

// Each occurrence of a stored entry at its stored origin with its own
// violations and F4 proofs: the validator's per-occurrence evidence.
export function storedOccurrenceProofs(entry, grammar = DESTRUCTIVE_GRAMMAR) {
  return originSites(entry, grammar).map((context) => ({
    index: (context.words[0]?.index ?? 0) + (context.site?.scope.offset ?? 0),
    violations: roleViolations(entry, context.words, grammar, context),
    proofs: context.trace.proofs,
  }));
}

const originKey = ({ sha, path, job, step }) => `${sha}\u0000${path}\u0000${job}\u0000${step}`;
const originScopes = new WeakMap();

// The stored origin record of an entry: its LF run text and the step, job
// and workflow env maps at that origin, self-hashed. Absent or altered
// records prove nothing.
function originRecord(grammar, origin) {
  const record = (grammar.origins ?? []).find((candidate) => originKey(candidate) === originKey(origin ?? {}));
  if (!record || typeof record.run !== "string") return null;
  const env = { workflow: record.env?.workflow ?? {}, job: record.env?.job ?? {}, step: record.env?.step ?? {} };
  return record.runSha256 === sha256(record.run) && record.envSha256 === sha256(JSON.stringify(env))
    ? { ...record, env }
    : null;
}

// Every occurrence of the entry's exact shape in its stored origin run (and
// the run's substitutions), each with its own site context.
function originSites(entry, grammar) {
  const record = Array.isArray(entry.words) ? originRecord(grammar, entry.origin) : null;
  if (!record) return [];
  const stored = (grammar.origins ?? []).find((candidate) => originKey(candidate) === originKey(record));
  if (!originScopes.has(stored)) originScopes.set(stored, lexicalScope(record.run));
  const root = originScopes.get(stored);
  const sites = [];
  const witness = entryOriginWitness(entry);
  const input = JSON.stringify(entry.input ?? []);
  const directories = runDirectories(record.run, root.lexed.tokens, record.env);
  for (const scope of scopesOf(root)) {
    const commands = commandsFromTokens(scope.lexed.tokens);
    for (const command of commands) {
      let { words } = resolveCommandWords(command, commands, scope.lexed.tokens);
      while (["command", "exec", "env"].includes(words[0]?.value) && !words[0].dynamic && words[1])
        words = words.slice(1);
      const body = JSON.stringify(
        command.redirects.filter(({ target }) => target?.body !== undefined).map(({ target }) => target.body),
      );
      const exact =
        words.length === entry.words.length &&
        body === input &&
        entry.words.every(
          (word, index) =>
            word.value === words[index].value &&
            word.dynamic === words[index].dynamic &&
            word.quoted === words[index].quoted,
        );
      if (!exact) continue;
      sites.push({
        ...siteContext(scope, command, {
          origin: witness,
          directories: directories
            .filter(({ after }) => after < (command.words[0]?.index ?? -1) + scope.offset)
            .map(({ operand }) => operand),
          env: record.env,
          grammar,
          trace: { unsited: false, proofs: [] },
        }),
        words,
      });
    }
  }
  return sites;
}

// Covered-token and role admission over `words`: the stored entry words when
// validating, the actual lexed tokens when classifying a match. The context's
// `origin` is the boot_smoke witness it proves, or null; `directories` are the
// origin-bound directory operands it proves.
function roleViolations(entry, words, grammar, context) {
  const covered =
    [...words.map((word) => word.value), ...(entry.input ?? [])].some(containsCoveredToken) ||
    words.some((word, index) => {
      if ((hopSelector(word) ?? basename(word.value)) !== "node") return false;
      const result = classifyCommand({ words: words.slice(index), redirects: [], assignments: [] }, grammar);
      return Boolean(result?.operation) || result?.disposition === "INDETERMINATE";
    });
  if (covered) return [`${entry.id}: benign payload contains a covered invocation.`];
  if (
    !admitsProgramAt(words, 0, { ...context, input: entry.input, entry: entry.id }) ||
    shellOrEvalAnywhereUnpinned(words)
  )
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
  if (selector === "[[") return words.at(-1)?.value === "]]" && conditionalExpression(words.slice(1, -1));
  return true;
}

// `[[` operands: unary and binary primaries, `!` and parentheses joined by &&
// and ||. Every operator is a literal conditional word; operands are data.
const conditionalUnary = spaced("-z -n -f -d -e -s -r -w -x -L -h -v");
const conditionalBinary = spaced("== != =~ = < > -eq -ne -lt -le -gt -ge -nt -ot");
function conditionalExpression(words) {
  let index = 0;
  const operator = (value) => literal(words[index], value);
  const operand = () => {
    const word = words[index];
    if (!word || (!word.dynamic && ["&&", "||", "(", ")", "!"].includes(word.value))) return false;
    index += 1;
    return true;
  };
  const primary = () => {
    if (operator("!")) {
      index += 1;
      return primary();
    }
    if (operator("(")) {
      index += 1;
      if (!disjunction() || !operator(")")) return false;
      index += 1;
      return true;
    }
    if (!words[index]?.dynamic && conditionalUnary.has(words[index]?.value) && words[index + 1]) {
      index += 1;
      return operand();
    }
    if (!operand()) return false;
    if (!words[index]?.dynamic && conditionalBinary.has(words[index]?.value)) {
      index += 1;
      return operand();
    }
    return true;
  };
  const disjunction = () => {
    if (!primary()) return false;
    while (operator("&&") || operator("||")) {
      index += 1;
      if (!primary()) return false;
    }
    return true;
  };
  return words.length > 0 && disjunction() && index === words.length;
}

// The first matching entry that admits the actual command, or the named
// refusal of a matching entry that does not.
function benignFormMatch(command, grammar, context) {
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
    const [violation] = shape ? [shape] : dataOnly ? [] : roleViolations(entry, words, grammar, context);
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

const noContext = { origin: null, directories: [] };

function classifyCommand(command, grammar, context = noContext) {
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
  const match = benignFormMatch({ ...command, words }, grammar, context);
  return match.admitted ? null : unknown(match.refusal ?? "unlisted executable form");
}

const defaultGrammarProof = validateGrammarPartition();
const grammarProof = (grammar) =>
  grammar === DESTRUCTIVE_GRAMMAR ? defaultGrammarProof : validateGrammarPartition(grammar);

// `env` holds the step/job/workflow env declarations the run executes under;
// operands rooted in a name it does not declare and the run does not bind
// prove nothing.
export function classifyShellCommands(run, { grammar = DESTRUCTIVE_GRAMMAR, env = {} } = {}) {
  if (typeof run !== "string") return { invocations: [], operations: [], indeterminate: [], proofs: [] };
  return classifyRun(run, grammar, grammarProof(grammar), env);
}

// A complete run block. Only a block that is exactly an origin witness carries
// that witness, and only into its proved substitution occurrence.
function classifyRun(run, grammar, proof, env = {}) {
  const witness = runOriginWitness(run);
  const text = witness?.run ?? run;
  const trace = { unsited: false, proofs: [] };
  const result = classifyProvedRun(text, grammar, proof, witness, null, lexicalScope(text), env, trace);
  return { ...result, proofs: trace.proofs };
}

// The site context of one command in `scope`.
function siteContext(scope, command, extra) {
  const first = command.words[0] ?? command.assignments[0]?.token;
  const node = first ? scope.nodes.get(first.index) : null;
  return { ...extra, site: node ? siteOf(scope, node) : null };
}

// One grammar proof covers a run and every substitution nested in it.
function classifyProvedRun(run, grammar, proof, witness, origin, scope, env, trace) {
  if (!proof.passed) {
    const unknown = { tool: "grammar", index: 0, disposition: "INDETERMINATE", reason: proof.violations.join("; ") };
    return { invocations: [unknown], operations: [], indeterminate: [unknown] };
  }
  const lexed = scope.lexed;
  const errors = [...lexed.errors];
  const commands = commandsFromTokens(lexed.tokens);
  for (const production of lexed.productions) {
    const handled = grammar.partition.some(
      (member) =>
        member.surface === "shell" && member.form.production === production && member.disposition === "HANDLED",
    );
    if (!handled) errors.push(`INDETERMINATE shell production ${production}`);
  }
  errors.push(...shellSyntaxErrors(lexed.tokens, commands, grammar));
  const directories = runDirectories(rootOf(scope).run, rootOf(scope).lexed.tokens, env);
  // A directory operand is proved only for commands after its last binding.
  const context = (command) =>
    siteContext(scope, command, {
      origin,
      directories: directories
        .filter(({ after }) => after < (command.words[0]?.index ?? -1) + scope.offset)
        .map(({ operand }) => operand),
      env,
      grammar,
      trace,
    });
  const invocations = commands
    .map((command) => classifyCommand(resolveCommandWords(command, commands, lexed.tokens), grammar, context(command)))
    .filter(Boolean);
  for (const substitution of lexed.substitutions) {
    const bound = witness !== null && substitution.index === witness.occurrence ? witness : null;
    const child = scope.children.find(({ index }) => index === substitution.index)?.scope;
    for (const invocation of classifyProvedRun(substitution.run, grammar, proof, null, bound, child, env, trace)
      .invocations)
      invocations.push({ ...invocation, index: substitution.index + invocation.index });
  }
  if (errors.length) {
    if (!invocations.length) invocations.push({ tool: "shell", index: 0 });
    const reason = errors.join(", ");
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
  const env = { workflow: workflow.env ?? {}, job: job.env ?? {}, step: step.env ?? {} };
  if (/^bash(?:\s|$)/.test(shell)) return classifyRun(step.run, grammar, proof, env);
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
  const result = checkWorkflow(source, workflowFile, grammar);
  delete result.proofs;
  return result;
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
  const proofs = [];
  const stepProof = proof ?? grammarProof(grammar);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (typeof step?.run !== "string") continue;
      const classification = classifyStep(workflow, job, step, grammar, stepProof);
      for (const item of classification.proofs ?? []) proofs.push({ jobId, stepIndex: index + 1, ...item });
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
  return { passed: violations.length === 0, checkedSteps, violations, proofs };
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

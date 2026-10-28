import { z } from "zod";
import { AppError } from "./errors";
import { ENTITIES, type EntityDef, type FieldDef } from "./entities";

export type FormInput = Record<string, string | undefined>;
export type Mode = "create" | "update";

const MONEY = /^\d{1,6}(\.\d{1,2})?$/; // decimal(8,2): max 999999.99
const INT = /^-?\d{1,10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INT32_MAX = 2_147_483_647;

/** SRS §3.3 Password Security: upper, lower, digit and special character. */
export const PASSWORD_RULE =
  "Password must be 8–72 characters and include an uppercase letter, a lowercase letter, a number and a special character.";
export function isStrongPassword(p: string) {
  return (
    p.length >= 8 &&
    p.length <= 72 && // bcrypt only uses the first 72 bytes
    /[A-Z]/.test(p) &&
    /[a-z]/.test(p) &&
    /[0-9]/.test(p) &&
    /[^A-Za-z0-9]/.test(p)
  );
}

function isRealDate(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fieldSchema(f: FieldDef, mode: Mode): z.ZodType<unknown> {
  const s = z.string().trim();
  switch (f.type) {
    case "text": {
      let t = s.max(f.max ?? 1000, `Max ${f.max} characters.`);
      if (f.required) t = t.min(1, "Required.");
      if (f.pattern) t = t.regex(f.pattern, f.patternHint ?? "Invalid format.");
      return t;
    }
    case "email":
      return s
        .toLowerCase()
        .max(f.max ?? 100, `Max ${f.max} characters.`)
        .pipe(z.email("Enter a valid email address."));
    case "int":
    case "money":
    case "date":
      return s.min(1, "Required.").superRefine((v, ctx) => {
        if (f.type === "int") {
          if (!INT.test(v) || Math.abs(Number(v)) > INT32_MAX) ctx.addIssue({ code: "custom", message: "Enter a whole number." });
          else if (f.min !== undefined && Number(v) < f.min) ctx.addIssue({ code: "custom", message: `Must be at least ${f.min}.` });
        } else if (f.type === "money") {
          if (!MONEY.test(v)) ctx.addIssue({ code: "custom", message: "Enter an amount like 1500 or 1500.50 (max 999999.99)." });
        } else if (!DATE.test(v) || !isRealDate(v)) {
          ctx.addIssue({ code: "custom", message: "Enter a valid date (YYYY-MM-DD)." });
        }
      });
    case "enum": {
      const opts = (mode === "update" && f.updateOptions) || f.options || [];
      return z.enum(opts as [string, ...string[]], { message: `Choose one of: ${opts.join(", ")}.` });
    }
    case "ref": {
      const target = ENTITIES[f.ref!];
      return target.pkType === "int"
        ? s.regex(/^\d{1,10}$/, "Select a record.")
        : s.min(1, "Select a record.").max(30);
    }
    case "password":
      return s.refine(isStrongPassword, PASSWORD_RULE);
    case "bool":
      return z.any().transform((v) => v === "on" || v === "true" || v === true);
  }
}

/** Fields a user may submit for this mode (computed / immutable ones are excluded). */
export function inputFields(e: EntityDef, mode: Mode) {
  return e.fields.filter(
    (f) => !f.computed && (mode === "create" ? f.onCreate !== false : f.onUpdate !== false),
  );
}

/**
 * Validates raw form strings for an entity. Unknown keys are ignored, so a
 * client can never write a column that isn't explicitly allowed.
 */
export function parseInput(e: EntityDef, mode: Mode, input: FormInput): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of inputFields(e, mode)) {
    const raw = input[f.name] ?? (mode === "create" ? f.defaultValue : undefined);
    // On update, a blank password means "keep the current one".
    if (f.type === "password" && mode === "update" && (raw ?? "").trim() === "") continue;
    if (f.type !== "bool" && (raw === undefined || raw.trim() === "") && !f.required) continue;
    const r = fieldSchema(f, mode).safeParse(f.type === "bool" ? raw : (raw ?? ""));
    if (r.success) values[f.name] = r.data;
    else errors[f.name] = r.error.issues[0]?.message ?? "Invalid value.";
  }
  if (Object.keys(errors).length) throw new AppError("validation", "Please fix the highlighted fields.", errors);
  return values;
}

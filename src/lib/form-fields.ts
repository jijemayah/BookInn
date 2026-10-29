import type { Db, Row } from "./db/types";
import type { Actor } from "./audit";
import { ENTITIES, canRead, writableFields, type EntityDef } from "./entities";
import { refOptions } from "./crud";
import type { FormField } from "@/components/forms";
import type { Mode } from "./validation";

/** Converts entity definitions into serialisable props for the client form, for this role. */
export async function buildFormFields(db: Db, actor: Actor, e: EntityDef, mode: Mode, row?: Row): Promise<FormField[]> {
  const writable = new Set(writableFields(e, actor.role, mode).map((f) => f.name));
  const out: FormField[] = [];
  for (const f of e.fields) {
    if (f.computed) continue;
    const immutable = mode === "update" && f.onUpdate === false;
    if (!writable.has(f.name) && !immutable) continue; // fields this role can't set are not shown
    let options: FormField["options"];
    if (f.type === "enum") {
      const opts = (mode === "update" && f.updateOptions) || f.options || [];
      options = opts.map((o) => ({ value: o, label: o }));
    } else if (f.type === "ref") {
      const target = ENTITIES[f.ref!];
      options = canRead(actor.role, target) ? await refOptions(db, actor, target.key) : [];
    }
    const current = row?.[f.name];
    out.push({
      name: f.name,
      label: f.label,
      type: f.type,
      required: f.type === "password" && mode === "update" ? false : f.required,
      max: f.max,
      min: f.min,
      help: f.type === "text" && f.patternHint ? `${f.patternHint}${f.help ? `. ${f.help}` : ""}` : f.help,
      options,
      readOnly: immutable,
      value: f.type === "password" ? "" : current !== undefined && current !== null ? String(current) : f.defaultValue,
    });
  }
  return out;
}

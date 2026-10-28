import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { canWrite } from "@/lib/entities";
import { buildFormFields } from "@/lib/form-fields";
import { createAction } from "@/app/actions";
import { EntityForm } from "@/components/forms";
import { Forbidden, loadEntityPage } from "../shared";

export default async function NewPage({ params }: PageProps<"/[entity]/new">) {
  const { entity } = await params;
  const { e, actor } = await loadEntityPage(entity);
  if (!canWrite(actor.role, e)) return <Forbidden e={e} />;
  const fields = await buildFormFields(getDb(), actor, e, "create");
  return (
    <>
      <p>
        <Link href={`/${e.key}`}>← {e.plural}</Link>
      </p>
      <h1>New {e.label.toLowerCase()}</h1>
      <div className="card">
        <EntityForm action={createAction.bind(null, e.key)} fields={fields} submitLabel={`Create ${e.label.toLowerCase()}`} />
      </div>
    </>
  );
}

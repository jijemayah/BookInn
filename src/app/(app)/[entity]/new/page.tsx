import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/pg";
import { can } from "@/lib/entities";
import { buildFormFields } from "@/lib/form-fields";
import { createAction } from "@/app/actions";
import { EntityForm } from "@/components/forms";
import { Alert, PageHeader } from "@/components/ui";
import { loadEntityPage } from "../shared";

export default async function NewPage({ params }: PageProps<"/[entity]/new">) {
  const { entity } = await params;
  const { e, actor } = await loadEntityPage(entity);
  if (e.key === "reservation") redirect("/book");
  if (!can(actor.role, e, "create"))
    return (
      <>
        <PageHeader title={`New ${e.label.toLowerCase()}`} back={{ href: `/${e.key}`, label: e.plural }} />
        <Alert kind="error">Your role ({actor.role}) cannot create {e.plural.toLowerCase()}.</Alert>
      </>
    );
  const fields = await buildFormFields(getDb(), actor, e, "create");
  return (
    <>
      <PageHeader title={`New ${e.label.toLowerCase()}`} back={{ href: `/${e.key}`, label: e.plural }} />
      {e.bookingFlow && (
        <Alert kind="warn">Correction form. Use New booking for regular bookings.</Alert>
      )}
      <div className="card">
        <EntityForm action={createAction.bind(null, e.key)} fields={fields} submitLabel={`Create ${e.label.toLowerCase()}`} />
      </div>
    </>
  );
}

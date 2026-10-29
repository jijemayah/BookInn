import { requireStaff } from "@/lib/session";
import { changePasswordAction, updateNameAction } from "@/app/actions";
import { NameForm, PasswordForm } from "@/components/forms";
import { PageHeader, Section } from "@/components/ui";
import { PASSWORD_RULE } from "@/lib/validation";

export default async function AccountPage() {
  const staff = await requireStaff();
  return (
    <>
      <PageHeader title="Account settings" description="Manage your own account (FR-03). Only the Database Administrator can change usernames, roles or account status." />
      <Section title="Your account">
        <dl className="details">
          <dt>Username</dt>
          <dd>{staff.username}</dd>
          <dt>Role</dt>
          <dd>{staff.role}</dd>
          <dt>Staff ID</dt>
          <dd>{staff.staffId}</dd>
        </dl>
      </Section>
      <Section title="Display name">
        <NameForm action={updateNameAction} name={staff.name} />
      </Section>
      <Section title="Change password">
        <p className="mb-4 text-sm text-muted">{PASSWORD_RULE}</p>
        <PasswordForm action={changePasswordAction} />
      </Section>
    </>
  );
}

import { requireStaff } from "@/lib/session";
import { changePasswordAction } from "@/app/actions";
import { PasswordForm } from "@/components/forms";
import { PASSWORD_RULE } from "@/lib/validation";

export default async function AccountPage() {
  const staff = await requireStaff();
  return (
    <>
      <h1>My account</h1>
      <section className="card">
        <dl className="details">
          <dt>Username</dt>
          <dd>{staff.username}</dd>
          <dt>Name</dt>
          <dd>{staff.name}</dd>
          <dt>Role</dt>
          <dd>{staff.role}</dd>
        </dl>
      </section>
      <section className="card" aria-labelledby="pw-h">
        <h2 id="pw-h">Change password</h2>
        <p className="muted">{PASSWORD_RULE}</p>
        <PasswordForm action={changePasswordAction} />
      </section>
    </>
  );
}

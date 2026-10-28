/**
 * Declarative description of the 11 SRS entities (§4.4 Data Dictionary).
 * Drives form rendering, input validation, list pages, and RBAC.
 * Table/column identifiers used in SQL come ONLY from this file — never from
 * user input — and all values are passed as query parameters.
 */

export const ROLES = ["Front Desk", "Finance", "Database Administrator"] as const;
export type Role = (typeof ROLES)[number];
const FD: Role = "Front Desk";
const FIN: Role = "Finance";
const DBA: Role = "Database Administrator";
const ALL: Role[] = [FD, FIN, DBA];

export const ENUMS = {
  booking_status: ["Booked", "Completed", "Cancelled"],
  room_type: ["Standard", "Deluxe"],
  room_view: ["Ocean View", "City View", "Garden View", "Pool View"],
  pay_method: ["Cash", "Bank", "Card", "Digital Wallet"],
  discount_type: ["NONE", "12% Discount", "Free Night"],
  cancelled_by: ["Customer", "Staff"],
  role: ROLES,
} as const;

export type FieldType = "text" | "email" | "int" | "money" | "date" | "enum" | "ref" | "password" | "bool";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  max?: number;
  min?: number;
  pattern?: RegExp;
  patternHint?: string;
  options?: readonly string[];
  /** For type "ref": the referenced entity key. */
  ref?: EntityKey;
  /** Accept on create (default true). */
  onCreate?: boolean;
  /** Accept on update (default true). Primary/foreign keys that define identity are fixed. */
  onUpdate?: boolean;
  /** Computed server-side: shown, never accepted from the form. */
  computed?: boolean;
  /** Show in list table (default true). */
  list?: boolean;
  defaultValue?: string;
  help?: string;
  /** Restrict enum options offered on update (business-rule driven). */
  updateOptions?: readonly string[];
}

export interface EntityDef {
  key: EntityKey;
  /** AUDIT_TRAIL.AFF_TAB value / SRS table name. */
  srsName: string;
  table: string;
  label: string;
  plural: string;
  pk: string;
  pkType: "int" | "text";
  /** true → identity column; false → natural key typed by the user. */
  pkGenerated: boolean;
  fields: FieldDef[];
  /** SQL expression (alias t) used as the human label in dropdowns / lists. */
  labelSql: string;
  read: Role[];
  write: Role[];
  /** Append-only entity: no create/update/delete via UI. */
  readOnly?: boolean;
  /** No editable columns after creation. */
  noUpdate?: boolean;
  description: string;
}

export const ENTITY_KEYS = [
  "customer",
  "loyalty_acc",
  "room_details",
  "room",
  "reservation",
  "reservation_room",
  "payment",
  "receipt",
  "cancellation",
  "staff",
  "audit_trail",
] as const;
export type EntityKey = (typeof ENTITY_KEYS)[number];

const MOBILE = /^\+?[0-9]{7,11}$/;

export const ENTITIES: Record<EntityKey, EntityDef> = {
  customer: {
    key: "customer",
    srsName: "CUSTOMER",
    table: "bookinn.customer",
    label: "Customer",
    plural: "Customers",
    pk: "cus_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "t.cus_name || ' <' || t.cus_email || '>'",
    read: ALL,
    write: [FD, DBA],
    description: "Guest records (FR-07 – FR-09).",
    fields: [
      { name: "cus_name", label: "Full name", type: "text", required: true, max: 100 },
      { name: "cus_email", label: "Email", type: "email", required: true, max: 100 },
      {
        name: "cus_mobile",
        label: "Mobile number",
        type: "text",
        required: true,
        max: 12,
        pattern: MOBILE,
        patternHint: "7–11 digits, optional leading +, e.g. 09061234567",
      },
    ],
  },
  loyalty_acc: {
    key: "loyalty_acc",
    srsName: "LOYALTY_ACC",
    table: "bookinn.loyalty_acc",
    label: "Loyalty account",
    plural: "Loyalty accounts",
    pk: "lyl_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "'#' || t.lyl_id || ' (' || t.total_pts || ' pts)'",
    read: ALL,
    write: [FD, FIN, DBA],
    description: "One loyalty account per guest (FR-10). Point posting/redemption is deferred to a later phase.",
    fields: [
      { name: "cus_id", label: "Customer", type: "ref", ref: "customer", required: true, onUpdate: false },
      { name: "total_pts", label: "Total points", type: "int", required: true, min: 0, defaultValue: "0" },
    ],
  },
  room_details: {
    key: "room_details",
    srsName: "ROOM_DETAILS",
    table: "bookinn.room_details",
    label: "Room type",
    plural: "Room types",
    pk: "room_type_id",
    pkType: "text",
    pkGenerated: false,
    labelSql: "t.room_type_id || ' – ' || t.room_type || ', ' || t.room_view || ' (₱' || t.room_price || ')'",
    read: ALL,
    write: [FD, DBA],
    description: "Room type catalogue: type, view and nightly price.",
    fields: [
      {
        name: "room_type_id",
        label: "Room type ID",
        type: "text",
        required: true,
        max: 4,
        pattern: /^[A-Z0-9]{1,4}$/,
        patternHint: "1–4 uppercase letters/digits, e.g. RT03",
        onUpdate: false,
      },
      { name: "room_type", label: "Room type", type: "enum", options: ENUMS.room_type, required: true },
      { name: "room_price", label: "Price per night (₱)", type: "money", required: true },
      { name: "room_view", label: "Room view", type: "enum", options: ENUMS.room_view, required: true },
    ],
  },
  room: {
    key: "room",
    srsName: "ROOM",
    table: "bookinn.room",
    label: "Room",
    plural: "Rooms",
    pk: "room_no",
    pkType: "int",
    pkGenerated: false,
    labelSql: "'Room ' || t.room_no",
    read: ALL,
    write: [FD, DBA],
    description: "Physical rooms (FR-11, FR-12).",
    fields: [
      { name: "room_no", label: "Room number", type: "int", required: true, min: 1, onUpdate: false },
      { name: "room_type_id", label: "Room type", type: "ref", ref: "room_details", required: true },
    ],
  },
  reservation: {
    key: "reservation",
    srsName: "RESERVATION",
    table: "bookinn.reservation",
    label: "Reservation",
    plural: "Reservations",
    pk: "res_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "'#' || t.res_id || ' (' || t.booking_status || ')'",
    read: ALL,
    write: [FD, DBA],
    description:
      "Bookings (FR-13 – FR-17). Add rooms via Reservation rooms. Cancel by creating a Cancellation record.",
    fields: [
      { name: "cus_id", label: "Customer", type: "ref", ref: "customer", required: true },
      {
        name: "booking_status",
        label: "Booking status",
        type: "enum",
        options: ENUMS.booking_status,
        updateOptions: ["Booked", "Completed"],
        onCreate: false,
        required: true,
        help: "New reservations start as Booked. Use a Cancellation record to cancel.",
      },
    ],
  },
  reservation_room: {
    key: "reservation_room",
    srsName: "RESERVATION_ROOM",
    table: "bookinn.reservation_room",
    label: "Reservation room",
    plural: "Reservation rooms",
    pk: "res_room_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "'#' || t.res_room_id || ' room ' || t.room_no",
    read: ALL,
    write: [FD, DBA],
    description:
      "Rooms and stay dates within a reservation. Double-booking is rejected; locked once the reservation is paid.",
    fields: [
      { name: "res_id", label: "Reservation", type: "ref", ref: "reservation", required: true, onUpdate: false },
      { name: "room_no", label: "Room", type: "ref", ref: "room", required: true },
      { name: "check_in_date", label: "Check-in date", type: "date", required: true },
      { name: "check_out_date", label: "Check-out date", type: "date", required: true },
    ],
  },
  payment: {
    key: "payment",
    srsName: "PAYMENT",
    table: "bookinn.payment",
    label: "Payment",
    plural: "Payments",
    pk: "pay_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "'#' || t.pay_id || ' – ₱' || t.pay_amt",
    read: ALL,
    write: [FIN, DBA],
    description:
      "One payment per reservation (FR-18 – FR-20). A receipt is generated automatically. Overpayment is rejected.",
    fields: [
      { name: "res_id", label: "Reservation", type: "ref", ref: "reservation", required: true, onUpdate: false },
      { name: "pay_method", label: "Payment method", type: "enum", options: ENUMS.pay_method, required: true },
      { name: "pay_date", label: "Payment date", type: "date", required: true },
      { name: "pay_amt", label: "Amount paid (₱)", type: "money", required: true },
      {
        name: "discount_type",
        label: "Discount",
        type: "enum",
        options: ENUMS.discount_type,
        required: true,
        defaultValue: "NONE",
        help: "12% Discount = 100 pts, Free Night = 250 pts (requires a loyalty account with enough points).",
      },
      { name: "pts_earn", label: "Points earned", type: "int", computed: true },
      { name: "pts_spend", label: "Points spent", type: "int", computed: true },
    ],
  },
  receipt: {
    key: "receipt",
    srsName: "RECEIPT",
    table: "bookinn.receipt",
    label: "Receipt",
    plural: "Receipts",
    pk: "rct_no",
    pkType: "int",
    pkGenerated: true,
    labelSql: "'Receipt #' || t.rct_no",
    read: ALL,
    write: [FIN, DBA],
    noUpdate: true,
    description: "One receipt per payment; created automatically with each payment. Email delivery is deferred.",
    fields: [{ name: "pay_id", label: "Payment", type: "ref", ref: "payment", required: true, onUpdate: false }],
  },
  cancellation: {
    key: "cancellation",
    srsName: "CANCELLATION",
    table: "bookinn.cancellation",
    label: "Cancellation",
    plural: "Cancellations",
    pk: "cancel_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "'#' || t.cancel_id",
    read: ALL,
    write: [FD, DBA],
    description:
      "Creating a cancellation sets the reservation to Cancelled and frees its rooms. No refunds. Deleting it reinstates the booking.",
    fields: [
      { name: "res_id", label: "Reservation", type: "ref", ref: "reservation", required: true, onUpdate: false },
      { name: "cancel_date", label: "Cancellation date", type: "date", required: true },
      { name: "cancelled_by", label: "Cancelled by", type: "enum", options: ENUMS.cancelled_by, required: true },
    ],
  },
  staff: {
    key: "staff",
    srsName: "STAFF",
    table: "bookinn.staff",
    label: "Staff account",
    plural: "Staff",
    pk: "staff_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "t.name || ' (' || t.u_name || ')'",
    read: [DBA],
    write: [DBA],
    description: "Staff logins and roles (FR-01 – FR-06). Deactivate instead of deleting staff with audit history.",
    fields: [
      {
        name: "u_name",
        label: "Username",
        type: "text",
        required: true,
        max: 30,
        pattern: /^[A-Za-z0-9._-]{3,30}$/,
        patternHint: "3–30 letters, digits, dot, dash or underscore",
      },
      { name: "name", label: "Full name", type: "text", required: true, max: 100 },
      { name: "role", label: "Role", type: "enum", options: ENUMS.role, required: true },
      {
        name: "pass",
        label: "Password",
        type: "password",
        required: true,
        list: false,
        help: "Min. 8 chars with upper, lower, digit and special character. Leave blank on edit to keep.",
      },
      { name: "is_active", label: "Active", type: "bool", defaultValue: "true" },
    ],
  },
  audit_trail: {
    key: "audit_trail",
    srsName: "AUDIT_TRAIL",
    table: "bookinn.audit_trail",
    label: "Audit entry",
    plural: "Audit trail",
    pk: "audit_id",
    pkType: "int",
    pkGenerated: true,
    labelSql: "'#' || t.audit_id",
    read: [DBA],
    write: [],
    readOnly: true,
    description: "Append-only log written automatically on every insert, update and delete.",
    fields: [
      { name: "staff_id", label: "Staff", type: "ref", ref: "staff" },
      { name: "action", label: "Action", type: "text" },
      { name: "aff_tab", label: "Table", type: "text" },
      { name: "rec_id", label: "Record ID", type: "int" },
      { name: "timestamp", label: "Timestamp", type: "text" },
      { name: "old_data", label: "Old data", type: "text" },
      { name: "new_data", label: "New data", type: "text" },
    ],
  },
};

export function isEntityKey(k: string): k is EntityKey {
  return (ENTITY_KEYS as readonly string[]).includes(k);
}

export function canRead(role: Role, e: EntityDef) {
  return e.read.includes(role);
}
export function canWrite(role: Role, e: EntityDef) {
  return !e.readOnly && e.write.includes(role);
}

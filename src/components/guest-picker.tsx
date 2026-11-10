"use client";
/**
 * One "Guest" field: type part of a name or email and matching guests drop down to pick
 * from (mouse, or ↑ ↓ Enter, Esc to close). The chosen guest's ID is submitted in a hidden
 * input named `name`. Editing the text after choosing clears the choice, so a booking is
 * never sent for a guest the field no longer shows. Accessible combobox pattern (ARIA 1.2).
 */
import { useId, useMemo, useRef, useState } from "react";

export interface GuestOption {
  value: string;
  label: string;
}

const MAX_SHOWN = 8;

/** Splits "NAME <email>" so the list can show the name with the email under it. */
const parts = (label: string) => {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(label);
  return m ? { name: m[1], email: m[2] } : { name: label, email: "" };
};

export function GuestPicker({
  name,
  options,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  name: string;
  options: GuestOption[];
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const selected = options.find((o) => o.value === value);
  const [text, setText] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const term = text.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!term || (selected && text === selected.label)) return [];
    return options.filter((o) => o.label.toLowerCase().includes(term)).slice(0, MAX_SHOWN);
  }, [options, term, text, selected]);
  const showList = open && matches.length > 0;
  const noMatch = open && !!term && !selected && matches.length === 0;

  const choose = (o: GuestOption) => {
    onChange(o.value);
    setText(o.label);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input type="hidden" name={name} value={value} />
      <input
        ref={inputRef}
        id="guest"
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${id}-opt-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        placeholder="Type a name or email"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
          if (value) onChange(""); // the text no longer matches the chosen guest
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && matches.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => (a + 1) % matches.length);
          } else if (e.key === "ArrowUp" && matches.length) {
            e.preventDefault();
            setActive((a) => (a - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter" && showList) {
            e.preventDefault(); // pick the guest, do not submit the form
            choose(matches[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={selected ? "pr-20" : undefined}
      />
      {selected && (
        <button
          type="button"
          className="btn-link absolute right-3 top-1/2 -translate-y-1/2"
          onClick={() => {
            onChange("");
            setText("");
            inputRef.current?.focus();
          }}
        >
          Change
        </button>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching guests"
        className={`${showList ? "animate-in" : "hidden"} absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-line bg-white py-1 shadow-lg`}
      >
        {matches.map((o, i) => {
          const p = parts(o.label);
          return (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: it fires before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-brand-100" : ""}`}
            >
              <span className="block font-medium text-ink">{p.name}</span>
              {p.email && <span className="block text-xs text-muted">{p.email}</span>}
            </li>
          );
        })}
      </ul>
      {noMatch && <p className="mt-1 text-xs text-muted" role="status">No guest matches “{text.trim()}”.</p>}
    </div>
  );
}

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

type Props = {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
};

/** A small chip-list editor: type + Enter (or comma) to add, click the x to remove. */
export function StringListEditor({ value, onChange, placeholder }: Props) {
  const [draft, setDraft] = useState("");

  function add() {
    const trimmed = draft.trim().toLowerCase();
    setDraft("");
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
  }

  function remove(item: string) {
    onChange(value.filter((v) => v !== item));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 && <p className="text-xs text-muted-foreground">None yet</p>}
        {value.map((item) => (
          <Badge key={item} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1.5">
            {item}
            <button
              type="button"
              onClick={() => remove(item)}
              className="rounded-full p-0.5 hover:bg-background/60"
            >
              <X className="h-3 w-3" />
              <span className="sr-only">Remove {item}</span>
            </button>
          </Badge>
        ))}
      </div>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder={placeholder}
      />
    </div>
  );
}

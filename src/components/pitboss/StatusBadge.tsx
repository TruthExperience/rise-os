type LicenceStatus = "active" | "suspended" | "revoked" | "expired";

interface StatusBadgeProps {
  status: LicenceStatus;
  className?: string;
}

const STATUS_STYLES: Record<LicenceStatus, { label: string; classes: string }> = {
  active: {
    label: "Active",
    classes: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/30",
  },
  suspended: {
    label: "Suspended",
    classes: "bg-amber-500/10 text-amber-400 ring-amber-500/30",
  },
  revoked: {
    label: "Revoked",
    classes: "bg-red-500/10 text-red-400 ring-red-500/30",
  },
  expired: {
    label: "Expired",
    classes: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/30",
  },
};

export default function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const { label, classes } = STATUS_STYLES[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${classes} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

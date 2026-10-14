import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parse, stringify, YAMLParseError } from "yaml";
import { confirmDialog } from "../components/dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Sheet } from "../components/sheet.tsx";
import { toast } from "../components/toast.tsx";
import {
  Badge,
  Button,
  Card,
  Dot,
  EmptyState,
  ErrorNote,
  IconButton,
  PageHeader,
  Segmented,
  Spinner,
  Switch,
  TextField,
  cx,
} from "../components/ui.tsx";
import {
  api,
  errorMessage,
  type PluginPreview,
  type PluginRow,
} from "../lib/api.ts";
import { useT, type MessageKey } from "../lib/i18n.ts";
import { useCan } from "../lib/session.ts";

/** Settings → Plugins: what runs, versions and updates; install, upgrade, configure, remove. */
export function PluginsPage() {
  const t = useT();
  const canAdmin = useCan("admin");
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Install sheet: open with an optional package name to prefill. */
  const [installing, setInstalling] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<PluginRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (updates = false, force = false) => {
    try {
      setRows(await api.pluginRows(updates, force));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!canAdmin) return;
    // Fast list first, then the (slower, network) update check.
    void load().then(() => load(true));
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [canAdmin, load]);

  const act = async (
    row: PluginRow,
    label: string,
    fn: () => Promise<unknown>,
  ) => {
    setBusy(row.id);
    try {
      await fn();
      toast(label);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
      await load(true);
    }
  };

  const remove = async (row: PluginRow) => {
    const ok = await confirmDialog({
      title: t(
        row.canUninstall ? "plugins.uninstallTitle" : "plugins.removeTitle",
        { id: row.id },
      ),
      body: t(
        row.canUninstall ? "plugins.uninstallBody" : "plugins.removeBody",
      ),
      confirmLabel: t(
        row.canUninstall ? "plugins.uninstall" : "plugins.remove",
      ),
      danger: true,
      icon: "trash",
    });
    if (ok)
      await act(row, t("plugins.removed", { id: row.id }), () =>
        api.removePlugin(row.id, row.canUninstall),
      );
  };

  const groups: { key: MessageKey; rows: PluginRow[] }[] = rows
    ? [
        {
          key: "plugins.group.active" as MessageKey,
          rows: rows.filter((r) => r.enabled),
        },
        {
          key: "plugins.group.disabled" as MessageKey,
          rows: rows.filter((r) => !r.enabled && r.configured),
        },
        {
          key: "plugins.group.available" as MessageKey,
          rows: rows.filter((r) => !r.enabled && !r.configured),
        },
      ].filter((g) => g.rows.length)
    : [];
  const updates = rows?.filter((r) => r.updateAvailable).length ?? 0;

  return (
    <>
      <PageHeader
        title={t("plugins.title")}
        subtitle={t("plugins.subtitle")}
        actions={
          canAdmin && (
            <>
              <Button
                icon="rotateCcw"
                busy={checking}
                onClick={async () => {
                  setChecking(true);
                  await load(true, true);
                  setChecking(false);
                }}
              >
                {t("plugins.checkUpdates")}
              </Button>
              <Button
                variant="amber"
                icon="plus"
                onClick={() => setInstalling("")}
              >
                {t("plugins.install")}
              </Button>
            </>
          )
        }
      />
      {!canAdmin ? (
        <Card>
          <EmptyState
            icon="lock"
            title={t("plugins.adminOnly")}
            body={t("plugins.adminOnlyBody")}
          />
        </Card>
      ) : error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !rows ? (
        <div className="grid place-items-center py-16 text-muted">
          <Spinner size={22} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {updates > 0 && (
            <div className="flex items-center gap-2.5 rounded-[14px] bg-amber-soft px-3.5 py-3 text-[13.5px]">
              <Icon
                name="arrowUpToLine"
                size={17}
                className="shrink-0 text-amber-ink"
              />
              {t("plugins.updatesAvailable", { n: updates })}
            </div>
          )}
          {groups.map((g) => (
            <section key={g.key} className="flex flex-col gap-2.5">
              <h2 className="m-0 text-[12px] font-bold tracking-wide text-muted uppercase">
                {t(g.key)}
              </h2>
              <div className="grid gap-3 xl:grid-cols-2">
                {g.rows.map((row) => (
                  <PluginCard
                    key={row.id}
                    row={row}
                    busy={busy === row.id}
                    onToggle={(on) =>
                      act(
                        row,
                        t(
                          on ? "plugins.enabledToast" : "plugins.disabledToast",
                          { id: row.id },
                        ),
                        () => api.setPluginEnabled(row.id, on),
                      )
                    }
                    onRestart={() =>
                      act(row, t("plugins.restarted", { id: row.id }), () =>
                        api.restartPlugin(row.id),
                      )
                    }
                    onUpgrade={() =>
                      act(
                        row,
                        t("plugins.upgraded", {
                          id: row.id,
                          v: row.latest ?? "",
                        }),
                        () => api.upgradePlugin(row.id),
                      )
                    }
                    onConfigure={() => setConfiguring(row)}
                    onRemove={() => void remove(row)}
                    onInstall={() => setInstalling(row.module ?? "")}
                  />
                ))}
              </div>
            </section>
          ))}
          <p className="m-0 text-center text-[12.5px] text-pretty text-muted">
            {t("plugins.foot")}
          </p>
        </div>
      )}
      {installing !== null && (
        <InstallSheet
          initialSpec={installing}
          onClose={() => setInstalling(null)}
          onInstalled={async () => {
            setInstalling(null);
            await load(true);
          }}
        />
      )}
      {configuring && (
        <ConfigSheet
          row={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={async () => {
            setConfiguring(null);
            await load();
          }}
        />
      )}
    </>
  );
}

const SOURCE: Record<PluginRow["source"], MessageKey> = {
  bundled: "plugins.source.bundled",
  builtin: "plugins.source.builtin",
  installed: "plugins.source.installed",
  path: "plugins.source.path",
  missing: "plugins.source.missing",
};

function statusTone(row: PluginRow): "ok" | "alert" | "muted" | "amber" {
  if (row.status === "running") return "ok";
  if (row.status === "starting") return "amber";
  if (
    row.status === "crashed" ||
    row.status === "disabled" ||
    row.status === "missing"
  )
    return "alert";
  return "muted";
}

function PluginCard({
  row,
  busy,
  onToggle,
  onRestart,
  onUpgrade,
  onConfigure,
  onRemove,
  onInstall,
}: {
  row: PluginRow;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onRestart: () => void;
  onUpgrade: () => void;
  onConfigure: () => void;
  onRemove: () => void;
  onInstall: () => void;
}) {
  const t = useT();
  const tone = statusTone(row);
  // An official plugin this build does not include (e.g. Zigbee in the single-file binary).
  const notIncluded = row.source === "missing" && !row.configured;
  const status = t(`plugins.status.${row.status}` as MessageKey);
  return (
    <Card className="flex flex-col gap-3 p-4!">
      <div className="flex items-start gap-3">
        <span
          className={cx(
            "grid size-10 shrink-0 place-items-center rounded-[12px]",
            row.enabled ? "bg-amber-soft text-amber-ink" : "bg-chip text-muted",
          )}
        >
          <Icon name="puzzle" size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[15px] font-extrabold tracking-[-0.01em]">
              {row.id}
            </span>
            {row.version && (
              <span className="font-mono text-[12px] text-muted">
                v{row.version}
              </span>
            )}
            {row.official && <Badge>{t("plugins.official")}</Badge>}
            {row.updateAvailable && (
              <Badge tone="amber">
                {t("plugins.updateTo", { v: row.latest ?? "" })}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">
            {row.module ?? row.path}
          </div>
          {row.description && (
            <p className="mt-1.5 mb-0 text-[13px] leading-snug text-pretty text-muted">
              {row.description}
            </p>
          )}
        </div>
        {notIncluded ? (
          <Button size="sm" variant="amber" icon="plus" onClick={onInstall}>
            {t("plugins.installShort")}
          </Button>
        ) : (
          <Switch
            checked={row.enabled}
            pending={busy}
            disabled={busy || row.source === "missing"}
            onChange={onToggle}
            label={t("plugins.enabledLabel", { id: row.id })}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]">
        <span className="inline-flex items-center gap-1.5 font-bold">
          <Dot tone={tone} />
          {status}
        </span>
        <span className="text-muted">
          {t(notIncluded ? "plugins.source.notIncluded" : SOURCE[row.source])}
        </span>
        {row.enabled && (
          <span className="text-muted">
            {t(
              row.isolation === "process"
                ? "plugins.isolation.process"
                : "plugins.isolation.inProcess",
            )}
          </span>
        )}
        {row.devices !== undefined && row.enabled && (
          <span className="text-muted">
            {t("plugins.devices", { n: row.devices })}
          </span>
        )}
        {(row.restarts ?? 0) > 0 && (
          <span className="text-muted">
            {t("plugins.restarts", { n: row.restarts ?? 0 })}
          </span>
        )}
      </div>
      {row.lastError && row.status !== "running" && (
        <ErrorNote>{row.lastError}</ErrorNote>
      )}
      {!notIncluded && row.configured && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {row.updateAvailable && row.canUpgrade && (
            <Button
              size="sm"
              variant="amber"
              icon="arrowUpToLine"
              disabled={busy}
              onClick={onUpgrade}
            >
              {t("plugins.upgrade")}
            </Button>
          )}
          <Button
            size="sm"
            icon="sliders"
            disabled={busy}
            onClick={onConfigure}
          >
            {t("plugins.configure")}
          </Button>
          {row.enabled && (
            <Button
              size="sm"
              icon="rotateCcw"
              disabled={busy}
              onClick={onRestart}
            >
              {t("plugins.restart")}
            </Button>
          )}
          {(row.configured || row.canUninstall) && (
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              className="ml-auto"
              disabled={busy}
              onClick={onRemove}
            >
              {t(row.canUninstall ? "plugins.uninstall" : "plugins.remove")}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- configure

function ConfigSheet({
  row,
  onClose,
  onSaved,
}: {
  row: PluginRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [text, setText] = useState(() =>
    Object.keys(row.config).length
      ? stringify(row.config, { lineWidth: 0 })
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const v: unknown = text.trim() ? parse(text) : {};
    if (v === null || typeof v !== "object" || Array.isArray(v))
      parseError = t("plugins.config.notMapping");
    else parsed = v as Record<string, unknown>;
  } catch (e) {
    parseError =
      e instanceof YAMLParseError
        ? (e.message.split("\n")[0] ?? e.message)
        : String(e);
  }

  const save = async () => {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.configurePlugin(row.id, parsed);
      if (next.status === "crashed" || next.status === "disabled")
        setError(
          t("plugins.config.failed", { e: next.lastError ?? next.status }),
        );
      else {
        toast(t("plugins.config.saved", { id: row.id }));
        await onSaved();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet label={t("plugins.config.title", { id: row.id })} onClose={onClose}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 text-lg font-extrabold">
              {t("plugins.config.title", { id: row.id })}
            </h2>
            <p className="mt-1 mb-0 text-[13px] leading-relaxed text-pretty text-muted">
              {t("plugins.config.hint")}
            </p>
          </div>
          <IconButton icon="x" label={t("common.close")} onClick={onClose} />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label={t("plugins.config.title", { id: row.id })}
          placeholder={"serialPort: /dev/ttyUSB0\n"}
          className="min-h-[260px] w-full resize-y rounded-ctl border border-line bg-surface2 p-3.5 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-amber-ink"
        />
        {parseError && (
          <div className="text-[12.5px] text-alert">{parseError}</div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon="check"
            busy={busy}
            disabled={!parsed}
            onClick={() => void save()}
          >
            {row.enabled
              ? t("plugins.config.saveRestart")
              : t("plugins.config.save")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- install

type Step =
  | { kind: "source" }
  | { kind: "resolving" }
  | { kind: "preview"; preview: PluginPreview }
  | { kind: "installing"; preview: PluginPreview };

function InstallSheet({
  initialSpec,
  onClose,
  onInstalled,
}: {
  initialSpec: string;
  onClose: () => void;
  onInstalled: () => Promise<void>;
}) {
  const t = useT();
  const [mode, setMode] = useState<"npm" | "file">("npm");
  const [spec, setSpec] = useState(initialSpec);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [step, setStep] = useState<Step>({ kind: "source" });
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const preview = async () => {
    setError(null);
    setStep({ kind: "resolving" });
    try {
      const p =
        mode === "npm"
          ? await api.resolvePluginSpec(spec.trim())
          : await api.resolvePluginFile(file!, file!.name, setProgress);
      setStep({ kind: "preview", preview: p });
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: "source" });
    } finally {
      setProgress(null);
    }
  };

  const install = async (p: PluginPreview) => {
    setError(null);
    setStep({ kind: "installing", preview: p });
    try {
      const row = await api.installPlugin(
        p.uploadId
          ? { uploadId: p.uploadId }
          : { spec: `${p.root.name}@${p.root.version}` },
      );
      if (row.status === "running")
        toast(t("plugins.installed", { id: row.id, v: row.version ?? "" }));
      else
        toast(
          t("plugins.installedNotRunning", {
            id: row.id,
            e: row.lastError ?? row.status,
          }),
          "error",
        );
      await onInstalled();
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: "preview", preview: p });
    }
  };

  const ready = mode === "npm" ? spec.trim().length > 0 : file !== null;
  const p =
    step.kind === "preview" || step.kind === "installing" ? step.preview : null;

  return (
    <Sheet label={t("plugins.install")} onClose={onClose}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 text-lg font-extrabold">
              {t("plugins.install")}
            </h2>
            <p className="mt-1 mb-0 text-[13px] leading-relaxed text-pretty text-muted">
              {t("plugins.installHint")}
            </p>
          </div>
          <IconButton icon="x" label={t("common.close")} onClick={onClose} />
        </div>

        {!p ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready && step.kind === "source") void preview();
            }}
          >
            <Segmented
              label={t("plugins.install")}
              value={mode}
              onChange={(v) => setMode(v)}
              options={[
                { value: "npm", label: t("plugins.fromNpm") },
                { value: "file", label: t("plugins.fromFile") },
              ]}
            />
            {mode === "npm" ? (
              <TextField
                label={t("plugins.package")}
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder="livynq-plugin-acme · @scope/livynq-plugin-x@1.2.0"
                hint={t("plugins.packageHint")}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                className="[&_input]:font-mono"
              />
            ) : (
              <div
                className="flex flex-col items-center gap-2 rounded-card border-[1.5px] border-dashed border-line px-4 py-7 text-center"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) setFile(f);
                }}
              >
                <Icon name="upload" size={22} className="text-muted" />
                <div className="text-[13.5px] font-bold">
                  {file ? file.name : t("plugins.dropFile")}
                </div>
                <div className="text-[12px] text-muted">
                  {t("plugins.fileHint")}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".tgz,.tar.gz,application/gzip"
                  className="sr-only"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <Button size="sm" onClick={() => fileInput.current?.click()}>
                  {t("plugins.chooseFile")}
                </Button>
              </div>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                icon="search"
                busy={step.kind === "resolving"}
                disabled={!ready}
              >
                {step.kind === "resolving" && progress !== null && progress < 1
                  ? `${Math.round(progress * 100)}%`
                  : t("plugins.preview")}
              </Button>
              <span className="text-xs text-muted">
                {t("plugins.previewHint")}
              </span>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1 rounded-card bg-surface2 p-4">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[16px] font-extrabold break-all">
                  {p.root.name}
                </span>
                <span className="font-mono text-[13px] text-muted">
                  v{p.root.version}
                </span>
              </div>
              {p.root.description && (
                <p className="m-0 text-[13px] leading-snug text-pretty text-muted">
                  {p.root.description}
                </p>
              )}
              <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <Fact
                  k={t("plugins.facts.id")}
                  v={<code className="font-mono">{p.id}</code>}
                />
                <Fact k={t("plugins.facts.author")} v={p.root.author ?? "—"} />
                <Fact
                  k={t("plugins.facts.license")}
                  v={p.root.license ?? "—"}
                />
                <Fact
                  k={t("plugins.facts.dependencies")}
                  v={t("plugins.facts.packages", { n: p.packages.length })}
                />
                <Fact
                  k={t("plugins.facts.sdk")}
                  v={
                    p.sdk.ranges.length
                      ? `${p.sdk.ranges.join(", ")} · ${p.sdk.compatible ? t("plugins.facts.compatible") : t("plugins.facts.incompatible", { v: p.sdk.provided })}`
                      : "—"
                  }
                />
                <Fact
                  k={t("plugins.facts.source")}
                  v={p.source === "file" ? p.spec : t("plugins.facts.registry")}
                />
                {p.installedVersion && (
                  <Fact
                    k={t("plugins.facts.installed")}
                    v={`v${p.installedVersion}`}
                  />
                )}
                {p.root.homepage && (
                  <Fact
                    k={t("plugins.facts.homepage")}
                    v={
                      <a
                        href={p.root.homepage}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="break-all text-ink underline"
                      >
                        {p.root.homepage}
                      </a>
                    }
                  />
                )}
              </dl>
            </div>
            {p.conflict && <ErrorNote>{p.conflict}</ErrorNote>}
            {p.warnings.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {p.warnings.map((w) => (
                  <li
                    key={w}
                    className="flex items-start gap-2 text-[12.5px] leading-snug text-pretty"
                  >
                    <Icon
                      name="alert"
                      size={14}
                      className="mt-0.5 shrink-0 text-amber-ink"
                    />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-start gap-2.5 rounded-[14px] bg-alert-soft px-3.5 py-3 text-[13px] leading-relaxed text-pretty">
              <Icon
                name="shieldAlert"
                size={17}
                className="mt-0.5 shrink-0 text-alert"
              />
              <span>{t("plugins.trustWarning")}</span>
            </div>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="amber"
                icon="plus"
                busy={step.kind === "installing"}
                disabled={Boolean(p.conflict)}
                onClick={() => void install(p)}
              >
                {p.installedVersion
                  ? t("plugins.reinstall", { v: p.root.version })
                  : t("plugins.installVersion", { v: p.root.version })}
              </Button>
              <Button
                variant="ghost"
                disabled={step.kind === "installing"}
                onClick={() => setStep({ kind: "source" })}
              >
                {t("add.back")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="m-0 min-w-0 font-semibold break-words">{v}</dd>
    </>
  );
}

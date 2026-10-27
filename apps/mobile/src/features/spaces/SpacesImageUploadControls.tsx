import { useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { pickNativeSpaceImageFile } from "./expoOriginalFiles";
import { uuidv4 } from "../../lib/uuid";
import { mobileSpaceImageInsertion } from "./imageInsertion";
import type { SpacesPageReader } from "./reader";
import type { MobileSpaceUploads } from "./uploads";

export function SpacesImageUploadControls(props: {
  readonly runtime: MobileSpaceUploads;
  readonly reader: SpacesPageReader;
  readonly current: () => boolean;
  readonly writable: boolean;
}) {
  const owner = props.runtime.owner;
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = mobileSpaceImageInsertion(props.reader, props.current, uuidv4);
  const records = snapshot.records.filter(
    (record) =>
      record.key.environmentId === target.key.environmentId &&
      record.key.pageId === target.key.pageId,
  );
  const blocked = busy || snapshot.busy;
  const run = (operation: () => Promise<unknown>) => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    void operation()
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Image operation failed; original retained",
        ),
      )
      .finally(() => setBusy(false));
  };
  const choose = async () => {
    if (!props.writable || !props.current() || props.reader.editing.getSnapshot().focus)
      throw new Error("Finish native input and restore destination access first");
    const file = await pickNativeSpaceImageFile();
    if (!file) return;
    await props.runtime.retain(target.key, file.uri, file.name.trim() || "image", props.current);
  };
  return (
    <View className="gap-2 px-4 py-2">
      <Text className="font-bold text-foreground">Image originals</Text>
      <Text className="text-sm text-foreground-muted">
        Two retained slots across Spaces. Choose a PNG, JPEG, GIF or WebP file up to 10 MiB; upload
        it, then insert at the end of a complete page.
      </Text>
      <ControlPill
        variant="pill"
        label="Choose image file"
        disabled={blocked || !props.writable || !props.current()}
        onPress={() => run(choose)}
      />
      {records.map((record) => (
        <View key={record.id} className="gap-2">
          <Text className="text-foreground">
            {record.intent.name} · {record.phase} · {record.original.size} bytes
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {["original", "minting", "upload"].includes(record.phase) ? (
              <ControlPill
                variant="pill"
                label={record.phase === "original" ? "Upload original" : "Continue exact upload"}
                disabled={blocked || !props.writable || !props.current()}
                onPress={() => run(() => owner.upload(record.id))}
              />
            ) : null}
            {record.handle ? (
              <ControlPill
                variant="pill"
                label="Recover upload status"
                disabled={blocked || !props.current()}
                onPress={() => run(() => owner.recover(record.id))}
              />
            ) : null}
            {record.phase === "ready" || record.phase === "preparing" ? (
              <ControlPill
                variant="pill"
                label={
                  record.phase === "ready" ? "Insert image at page end" : "Finish exact insertion"
                }
                disabled={blocked || !props.writable || !props.current()}
                onPress={() => run(() => owner.insert(record.id, target))}
              />
            ) : null}
            {record.phase === "preparing" ? (
              <ControlPill
                variant="pill"
                label="Reselect unsent placement"
                disabled={blocked || !props.writable || !props.current()}
                onPress={() => run(() => owner.reselectPlacement(record.id, target))}
              />
            ) : null}
            {record.phase === "drafted" ? (
              <ControlPill
                variant="pill"
                label="Save / retry exact page save"
                disabled={blocked || !props.writable || !props.current()}
                onPress={() => run(() => props.reader.editing.save())}
              />
            ) : null}
            <ControlPill
              variant="pill"
              label="Release local original"
              disabled={
                blocked ||
                !props.current() ||
                record.phase === "minting" ||
                record.phase === "preparing"
              }
              onPress={() =>
                Dialog.confirm({
                  title: "Release retained original?",
                  message: `${record.intent.name}: its local file is removed only after upload and page-draft ownership checks succeed.`,
                  confirmText: "Release original",
                  destructive: true,
                  onConfirm: () => run(() => owner.release(record.id, target)),
                })
              }
            />
          </View>
          {record.phase === "minting" && !record.handle ? (
            <Text className="text-sm text-foreground-muted">
              The first grant may be uncertain. After restart it cannot be reminted without its
              original caller proof; the original stays retained.
            </Text>
          ) : null}
        </View>
      ))}
      {snapshot.records.length > records.length ? (
        <Text className="text-sm text-foreground-muted">
          Another page retains an original. Open that page to resolve or release it.
        </Text>
      ) : null}
      {!snapshot.hydrated ? (
        <ControlPill
          variant="pill"
          label="Retry original storage"
          disabled={blocked}
          onPress={() => run(() => owner.hydrate())}
        />
      ) : null}
      {error || snapshot.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ??
            (snapshot.error instanceof Error
              ? snapshot.error.message
              : "Original storage is unavailable; retained data was not removed")}
        </Text>
      ) : null}
    </View>
  );
}

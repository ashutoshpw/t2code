import { useRef, useState } from "react";
import type {
  SpacePageNavigationTarget,
  SpaceReferenceController,
} from "@t2code/client-runtime/spaces";
import type { SpaceReferenceResolveInput } from "@t2code/contracts/spaces";
import { Button } from "../components/ui/button";

export function SpaceSourceOpen({
  owner,
  target,
  current,
  onOpen,
  label,
}: {
  owner: SpaceReferenceController | null;
  target: SpaceReferenceResolveInput["target"];
  current: () => boolean;
  onOpen: (target: SpacePageNavigationTarget) => void;
  label: string;
}) {
  const stamp = JSON.stringify(target),
    request = useRef(0);
  const [state, setState] = useState<{
    owner: SpaceReferenceController;
    stamp: string;
    busy: boolean;
    result: Awaited<ReturnType<SpaceReferenceController["resolve"]>>;
    unavailable: boolean;
  } | null>(null);
  const saved = state?.owner === owner && state.stamp === stamp ? state : null;
  const resolved = saved?.result?.current();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={saved?.busy || !owner?.canResolve() || !current()}
        onClick={async () => {
          if (!owner?.canResolve() || !current()) return;
          const id = ++request.current;
          setState({ owner, stamp, busy: true, result: null, unavailable: false });
          const result = await owner.resolve(target);
          if (request.current !== id) return;
          setState({ owner, stamp, busy: false, result, unavailable: !result?.current() });
          if (!current()) return;
          const destination = result?.current();
          if (destination) onOpen(destination);
        }}
      >
        {saved?.busy
          ? "Resolving current source…"
          : resolved && saved?.result
            ? `Open ${saved.result.page.title || "Untitled page"}`
            : `Open ${label}`}
      </Button>
      {saved?.unavailable ? (
        <span role="status">
          Current source unavailable, deleted or in trash. Its stored reference is retained.
        </span>
      ) : null}
      {owner && !owner.canResolve() ? (
        <span role="status">
          Current-source navigation requires read access and advertised reference resolution.
        </span>
      ) : null}
    </span>
  );
}

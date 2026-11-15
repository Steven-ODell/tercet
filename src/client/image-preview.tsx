import { theme } from "./theme";
import { useEffect, useState } from "react";
import { mediaActions, type Actions } from "../actions";
import type { MarkdownRow } from "./markdown";
import { isRemoteSource } from "./image-preview-source";
import {
  fileSource,
  imageSize,
  media,
  mediaDetail,
  mediaFellBack,
  mediaKind,
  type MediaProbe,
} from "./media";

type Inspected = MediaProbe & { size?: number };

/** Remote images the user chose to load this session, so scrolling away and back keeps the choice. */
const loadedRemote = new Set<string>();

/**
 * One clipped media card per visible source; unmounting deletes its Kitty placement. Images draw
 * on the current rung; video shows its poster frame and duration; audio and other files, and
 * anything that cannot draw, show a placeholder. The top border holds the card's buttons.
 */
export function ImagePreview({
  image,
  width,
  effects,
  cwd,
  select,
  selected,
  hover,
  unhover,
  perform,
  visibleHeight,
}: {
  image: NonNullable<MarkdownRow["image"]>;
  width: number;
  effects?: Actions;
  cwd?: string;
  select: () => void;
  selected?: boolean;
  hover?: () => void;
  unhover?: () => void;
  perform?: (action: string) => void;
  visibleHeight: number;
}) {
  const kind = mediaKind(image.source);
  const [bytes, setBytes] = useState<Uint8Array>();
  const [info, setInfo] = useState<Inspected>();
  const [failed, setFailed] = useState(false);
  const [, consent] = useState(0);
  // A transcript's http(s) image could be a tracker or point at this machine: it waits for a click,
  // and with nothing to draw on (media.protocol "none") it never loads. Local files still load,
  // for the placeholder's size line.
  const remote = isRemoteSource(image.source);
  const drawable = media().rung !== "none";
  const allowed = !remote || (drawable && loadedRemote.has(image.source));
  const load = kind === "image" && allowed ? effects?.loadImage : undefined;
  const inspect = kind === "image" ? undefined : effects?.inspectMedia;
  useEffect(() => {
    let active = true;
    setBytes(undefined);
    setInfo(undefined);
    setFailed(false);
    const failure = () => {
      if (active) setFailed(true);
    };
    load?.(image.source, cwd).then((value) => {
      if (active) setBytes(value);
    }, failure);
    inspect?.(image.source, cwd).then((value) => {
      if (active) setInfo(value);
    }, failure);
    return () => {
      active = false;
    };
  }, [image.source, load, inspect, cwd]);
  const cells = image.source.startsWith("tercet-page:")
    ? width
    : Math.min(width, Math.max(34, image.height * 4));
  const left = image.right ? width - cells : 0;
  const inner = { width: Math.max(1, cells - 4), height: Math.max(1, image.height - 2) };
  const size = info?.size ?? fileSource(image.source)?.size;
  const askToLoad = kind === "image" && remote && drawable && !allowed && !!effects?.loadImage;
  const label = `[${kind} ${image.alt}]${failed ? " (unavailable)" : kind === "image" && !allowed ? " (remote)" : ""}`;
  const detail = mediaDetail({ ...info, size });
  return (
    <box height={visibleHeight} flexShrink={0} width={width}>
      <box
        position="absolute"
        top={-image.offset}
        left={left}
        width={cells}
        height={image.height}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={theme.muted}
        backgroundColor={selected ? theme.highlight : undefined}
        onMouseOver={hover}
        onMouseMove={hover}
        onMouseOut={unhover}
      >
        <box position="absolute" top={-1} right={1} height={1} flexDirection="row">
          {askToLoad ? (
            <text
              selectable={false}
              fg={theme.accent}
              attributes={1}
              onMouseUp={(event) => {
                if (event.button !== 0 || event.modifiers.shift) return;
                loadedRemote.add(image.source);
                consent((n) => n + 1);
              }}
            >
              {"[load] "}
            </text>
          ) : null}
          {mediaActions(effects, kind).map((action) => (
            <text
              key={action}
              selectable={false}
              fg={theme.accent}
              attributes={1}
              onMouseUp={(event) => {
                if (event.button === 0 && !event.modifiers.shift) perform?.(action);
              }}
            >
              {`[${action}] `}
            </text>
          ))}
        </box>
        {kind === "image" ? (
          <InlineImage
            bytes={failed ? undefined : bytes}
            width={inner.width}
            height={inner.height}
            select={select}
            fallback={label}
          />
        ) : kind === "video" && info?.poster && media().rung !== "none" && inner.height > 1 ? (
          <>
            <InlineImage
              bytes={info.poster}
              width={inner.width}
              height={inner.height - 1}
              select={select}
              fallback={label}
            />
            <MediaPlaceholder label={label} detail={detail} select={select} />
          </>
        ) : (
          <MediaPlaceholder label={label} detail={detail} select={select} />
        )}
      </box>
    </box>
  );
}

/** Name, then dimensions or duration and size. ASCII only, so every icon set can draw it. */
function MediaPlaceholder({
  label,
  detail,
  select,
}: {
  label: string;
  detail?: string;
  select?: () => void;
}) {
  const click = (event: import("@opentui/core").MouseEvent) => {
    if (event.button === 0 && !event.modifiers.shift) select?.();
  };
  return (
    <box flexDirection="row" flexShrink={0} height={1} onMouseUp={click}>
      <text fg={theme.accent} selectable={false}>
        {label}
      </text>
      {detail ? (
        <text fg={theme.muted} selectable={false}>
          {` ${detail}`}
        </text>
      ) : null}
    </box>
  );
}

/** Native placement belongs to this render tree; unmounting removes it from the terminal. */
export function InlineImage({
  bytes,
  width,
  height,
  select,
  fallback = "[image]",
}: {
  bytes?: Uint8Array;
  width: number;
  height: number;
  select?: () => void;
  fallback?: string;
}) {
  const { rung, hint } = media();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bytes]);
  // A fallback the user can fix (tmux passthrough) is explained once, on the status line.
  useEffect(() => {
    if (hint) mediaFellBack();
  }, [hint]);
  const click = (event: import("@opentui/core").MouseEvent) => {
    if (event.button === 0 && !event.modifiers.shift) select?.();
  };
  if (bytes && !failed && rung !== "none")
    return (
      <image
        source={bytes}
        protocol={rung}
        fit="fit"
        width={width}
        height={height}
        onMouseUp={click}
        onError={() => setFailed(true)}
      />
    );
  const known = bytes && imageSize(bytes);
  const detail = bytes && !failed ? mediaDetail({ ...known, size: bytes.length }) : "";
  // Clipped to the image's own cells, so a small chip's placeholder cannot push its neighbors.
  return (
    <box width={width} height={height} overflow="hidden" flexShrink={0}>
      <MediaPlaceholder label={fallback} detail={detail} select={select} />
    </box>
  );
}

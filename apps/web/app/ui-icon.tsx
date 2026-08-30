import type { ReactNode, SVGProps } from "react";

/**
 * The viewer's deliberately small, platform-neutral icon vocabulary. These are
 * stroke icons rather than font glyphs/emoji so their weight, colour and
 * baseline stay stable across Linux, iOS Safari and desktop browsers.
 */
type UiIconName =
  | "arrow-left"
  | "attach"
  | "auto"
  | "bell"
  | "branch"
  | "brand"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "code"
  | "disconnect"
  | "edit"
  | "error"
  | "eye"
  | "eye-off"
  | "file"
  | "info"
  | "model"
  | "more"
  | "output"
  | "plan"
  | "question"
  | "retry"
  | "send"
  | "session"
  | "shield"
  | "stop"
  | "task"
  | "terminal"
  | "thinking"
  | "tool";

interface UiIconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "title"> {
  name: UiIconName;
  size?: number | string;
  /**
   * Omit when the surrounding control/text already names the icon. Supplying a
   * title makes the SVG itself an accessible image.
   */
  title?: string;
}

const TITLES: Record<UiIconName, string> = {
  "arrow-left": "Back",
  attach: "Attachment",
  auto: "Auto mode",
  bell: "Needs attention",
  branch: "Git branch",
  brand: "Remote terminal",
  check: "Complete",
  "chevron-down": "Expand",
  "chevron-right": "Open",
  close: "Close",
  code: "Code mode",
  disconnect: "Disconnect",
  edit: "Edit",
  error: "Error",
  eye: "Show",
  "eye-off": "Hide",
  file: "File",
  info: "Information",
  model: "Model",
  more: "More",
  output: "Output",
  plan: "Plan mode",
  question: "Question",
  retry: "Retry",
  send: "Send",
  session: "Session",
  shield: "Permission",
  stop: "Stop",
  task: "Task",
  terminal: "Command",
  thinking: "Thinking",
  tool: "Tool",
};

/** A consistent 24px-viewBox icon. It inherits colour and never captures focus. */
export function UiIcon({ name, size = 20, title, ...svgProps }: UiIconProps) {
  const requestedHidden = svgProps["aria-hidden"];
  const ariaHidden = requestedHidden ?? title === undefined;
  const hidden = ariaHidden === true || ariaHidden === "true";
  const accessibleTitle = title ?? TITLES[name];
  return (
    <svg
      {...svgProps}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      aria-hidden={ariaHidden}
      aria-label={hidden ? undefined : accessibleTitle}
      role={hidden ? undefined : "img"}
      focusable="false"
    >
      <title>{accessibleTitle}</title>
      <IconPaths name={name} />
    </svg>
  );
}

function IconPaths({ name }: { name: UiIconName }): ReactNode {
  switch (name) {
    case "brand":
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="3.5" />
          <path d="m7.5 9 3 3-3 3M13.5 15H17" />
        </>
      );
    case "eye":
      return (
        <>
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.7" />
        </>
      );
    case "eye-off":
      return (
        <>
          <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.2 3M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6a9.7 9.7 0 0 0 3.1-.5" />
          <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        </>
      );
    case "auto":
      return <path d="m13.2 2.8-7 10.1h5.5l-.9 8.3 7-10.1h-5.5l.9-8.3Z" />;
    case "code":
      return <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M14 4l-4 16" />;
    case "plan":
      return (
        <>
          <path d="M10 6h10M10 12h10M10 18h10" />
          <path d="m3.5 6 1.3 1.3L7.2 5M3.5 12l1.3 1.3L7.2 11M3.5 18l1.3 1.3L7.2 17" />
        </>
      );
    case "model":
      return (
        <>
          <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
          <path d="m4 12 8 4.5 8-4.5M4 16.5l8 4.5 8-4.5" />
        </>
      );
    case "attach":
      return (
        <path d="m20.5 11.5-8.2 8.2a5.1 5.1 0 0 1-7.2-7.2l9-9a3.5 3.5 0 0 1 5 5l-9.1 9.1a1.9 1.9 0 1 1-2.7-2.7l8.2-8.2" />
      );
    case "send":
      return <path d="M12 20V4M5.5 10.5 12 4l6.5 6.5" />;
    case "stop":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
        </>
      );
    case "task":
      return (
        <>
          <path d="M12 3v3M9.5 3h5" />
          <rect x="4" y="6" width="16" height="13" rx="4" />
          <path d="M8.5 11h.01M15.5 11h.01M8.5 15.5h7" />
        </>
      );
    case "tool":
      return (
        <>
          <path d="m14.2 5.8 4-3.3 3.3 3.3-3.3 4M13 7l4 4" />
          <path d="m15.4 9.4-8.8 11a2.2 2.2 0 0 1-3.1-3.1l11-8.8" />
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="m7 9 3 3-3 3M13.5 15H17" />
        </>
      );
    case "file":
      return (
        <>
          <path d="M6 3h8l4 4v14H6V3Z" />
          <path d="M14 3v5h4M9 13h6M9 17h6" />
        </>
      );
    case "edit":
      return (
        <>
          <path d="m14.5 5.5 4 4M4 20l1.2-5.2L16.8 3.2a2 2 0 0 1 2.8 2.8L8 17.6 4 20Z" />
          <path d="m5.2 14.8 2.8 2.8" />
        </>
      );
    case "output":
      return (
        <>
          <path d="M4 5v10a4 4 0 0 0 4 4h12" />
          <path d="m15 14 5 5-5 5" transform="translate(0 -5)" />
        </>
      );
    case "thinking":
      return (
        <>
          <path d="M20 11.5a8 8 0 1 1-4.1-7L21 4l-.5 5.1a8 8 0 0 1-.5 2.4Z" />
          <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
        </>
      );
    case "shield":
      return (
        <>
          <path d="M12 2.8 20 6v5.3c0 5-3.4 8.4-8 9.9-4.6-1.5-8-4.9-8-9.9V6l8-3.2Z" />
          <rect x="8.5" y="10.5" width="7" height="5.5" rx="1.5" />
          <path d="M10 10.5V9a2 2 0 0 1 4 0v1.5" />
        </>
      );
    case "question":
      return (
        <>
          <path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2.2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v8Z" />
          <path d="M9.6 9a2.5 2.5 0 0 1 4.8 1c0 1.8-2.4 2-2.4 3.5M12 16h.01" />
        </>
      );
    case "branch":
      return (
        <>
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="6" cy="19" r="2" />
          <path d="M6 7v10M8 9c2.5 0 3 3 6 3h2M18 9v1a2 2 0 0 1-2 2" />
        </>
      );
    case "session":
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M8 4v16M11 9h6M11 13h4" />
        </>
      );
    case "info":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5M12 8h.01" />
        </>
      );
    case "disconnect":
      return (
        <>
          <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
          <path d="M14 8l4 4-4 4M9 12h9" />
        </>
      );
    case "error":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </>
      );
    case "check":
      return <path d="m4.5 12.5 4.5 4.5L19.5 6.5" />;
    case "close":
      return <path d="m5 5 14 14M19 5 5 19" />;
    case "more":
      return (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      );
    case "arrow-left":
      return <path d="M20 12H4m6-6-6 6 6 6" />;
    case "chevron-right":
      return <path d="m9 5 7 7-7 7" />;
    case "chevron-down":
      return <path d="m5 9 7 7 7-7" />;
    case "bell":
      return (
        <>
          <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
          <path d="M10 21h4" />
        </>
      );
    case "retry":
      return (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 8.2A7.5 7.5 0 0 1 20 12M4 12a7.5 7.5 0 0 0 13.9 3.8" />
        </>
      );
  }
}

import { createElement, type ComponentType, type CSSProperties, type HTMLAttributes } from "react";

/** Google Material Symbols Rounded, self-hosted and subset to the symbols used by this app. */
export type MaterialIconProps = Omit<HTMLAttributes<HTMLElement>, "color"> & {
  size?: number | string;
  color?: string;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
  mirrored?: boolean;
};
export type Icon = ComponentType<MaterialIconProps>;

function makeIcon(symbol: string, codepoint: number): Icon {
  const MaterialSymbol = ({ size = "1em", color, weight = "regular", mirrored, style, ...props }: MaterialIconProps) => {
    const fill = weight === "fill" || weight === "duotone" || props.className?.split(/\s+/).includes("is-on") ? 1 : 0;
    const stroke = weight === "thin" ? 200 : weight === "light" ? 300 : weight === "bold" ? 600 : 400;
    const opticalSize = typeof size === "number" ? Math.min(48, Math.max(20, size)) : 24;
    const iconStyle = {
      "--material-size": typeof size === "number" ? `${size}px` : size,
      display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none",
      fontFamily: '"Material Symbols Rounded App"', fontSize: "var(--material-size)",
      lineHeight: 1, fontStyle: "normal", fontWeight: stroke,
      fontVariationSettings: `"FILL" ${fill}, "wght" ${stroke}, "GRAD" 0, "opsz" ${opticalSize}`,
      fontFeatureSettings: '"liga"', whiteSpace: "nowrap", userSelect: "none",
      WebkitFontSmoothing: "antialiased", verticalAlign: "middle",
      ...(color ? { color } : {}), ...(mirrored ? { transform: "scaleX(-1)" } : {}), ...style,
    } as CSSProperties;
    const accessible = Boolean(props["aria-label"] || props.title);
    return createElement("i", {
      ...props,
      className: ["material-icon", props.className].filter(Boolean).join(" "),
      style: iconStyle,
      role: props.role ?? (accessible ? "img" : undefined),
      "aria-hidden": props["aria-hidden"] ?? (accessible ? undefined : true),
      "data-material-symbol": symbol,
    }, String.fromCodePoint(codepoint));
  };
  MaterialSymbol.displayName = `MaterialIcon(${symbol})`;
  return MaterialSymbol;
}

// Existing component names remain stable while every rendered glyph uses Google's font.

export const ArrowClockwise = makeIcon("refresh", 0xe5d5);
export const ArrowCounterClockwise = makeIcon("undo", 0xe166);
export const ArrowDown = makeIcon("arrow_downward", 0xe5db);
export const ArrowLeft = makeIcon("arrow_back", 0xe5c4);
export const ArrowRight = makeIcon("arrow_forward", 0xe5c8);
export const ArrowSquareOut = makeIcon("open_in_new", 0xe89e);
export const ArrowUUpLeft = makeIcon("replay", 0xe042);
export const ArrowUp = makeIcon("arrow_upward", 0xe5d8);
export const ArrowsClockwise = makeIcon("sync", 0xe627);
export const ArrowsLeftRight = makeIcon("swap_horiz", 0xe8d4);
export const Bed = makeIcon("bed", 0xefdf);
export const Bell = makeIcon("notifications", 0xe7f5);
export const BellRinging = makeIcon("notifications_active", 0xe7f7);
export const Brain = makeIcon("psychology", 0xea4a);
export const Broadcast = makeIcon("podcasts", 0xf048);
export const Buildings = makeIcon("apartment", 0xea40);
export const Bus = makeIcon("directions_bus", 0xeff6);
export const CalendarBlank = makeIcon("calendar_month", 0xebcc);
export const CalendarDots = makeIcon("event", 0xe878);
export const Camera = makeIcon("photo_camera", 0xe412);
export const CameraSlash = makeIcon("no_photography", 0xf1a8);
export const Car = makeIcon("directions_car", 0xeff7);
export const CaretDown = makeIcon("keyboard_arrow_down", 0xe313);
export const CaretLeft = makeIcon("chevron_left", 0xe5cb);
export const CaretRight = makeIcon("chevron_right", 0xe5cc);
export const Chat = makeIcon("chat_bubble", 0xe0cb);
export const ChatCenteredText = makeIcon("chat", 0xe0c9);
export const ChatSlash = makeIcon("chat_bubble_outline", 0xe0cb);
export const ChatText = makeIcon("sms", 0xe625);
export const Chats = makeIcon("forum", 0xe8af);
export const Check = makeIcon("check", 0xe668);
export const CheckCircle = makeIcon("check_circle", 0xf0be);
export const Checks = makeIcon("done_all", 0xe877);
export const Circle = makeIcon("circle", 0xef4a);
export const CircleNotch = makeIcon("progress_activity", 0xe9d0);
export const ClipboardText = makeIcon("assignment", 0xe85d);
export const Clock = makeIcon("schedule", 0xefd6);
export const Compass = makeIcon("explore", 0xe87a);
export const Copy = makeIcon("content_copy", 0xe14d);
export const CreditCard = makeIcon("credit_card", 0xe8a1);
export const Crosshair = makeIcon("my_location", 0xe55c);
export const CurrencyCircleDollar = makeIcon("paid", 0xf041);
export const DeviceMobile = makeIcon("smartphone", 0xe7ba);
export const Door = makeIcon("door_front", 0xeffd);
export const DoorOpen = makeIcon("meeting_room", 0xeb4f);
export const DownloadSimple = makeIcon("download", 0xf090);
export const Envelope = makeIcon("mail", 0xe159);
export const EnvelopeSimple = makeIcon("mail", 0xe159);
export const Eye = makeIcon("visibility", 0xe8f4);
export const EyeSlash = makeIcon("visibility_off", 0xe8f5);
export const FilmSlate = makeIcon("movie", 0xe404);
export const Flag = makeIcon("flag", 0xf0c6);
export const Flask = makeIcon("science", 0xea4b);
export const FloppyDisk = makeIcon("save", 0xe161);
export const ForkKnife = makeIcon("restaurant", 0xe56c);
export const Gavel = makeIcon("gavel", 0xe90e);
export const Gear = makeIcon("settings", 0xe8b8);
export const GearSix = makeIcon("settings", 0xe8b8);
export const Globe = makeIcon("public", 0xe80b);
export const House = makeIcon("home", 0xe9b2);
export const IdentificationCard = makeIcon("badge", 0xea67);
export const ImageSquare = makeIcon("image", 0xe3f4);
export const Info = makeIcon("info", 0xe88e);
export const Key = makeIcon("key", 0xe73c);
export const Lifebuoy = makeIcon("support_agent", 0xf0e2);
export const Lightning = makeIcon("bolt", 0xea0b);
export const LinkSimple = makeIcon("link", 0xe250);
export const Lock = makeIcon("lock", 0xe899);
export const LockKey = makeIcon("lock", 0xe899);
export const LockOpen = makeIcon("lock_open", 0xe898);
export const MagnifyingGlass = makeIcon("search", 0xef7a);
export const MapPin = makeIcon("location_on", 0xf1db);
export const MapPinLine = makeIcon("location_on", 0xf1db);
export const Megaphone = makeIcon("campaign", 0xef49);
export const Microphone = makeIcon("mic", 0xe31d);
export const MicrophoneSlash = makeIcon("mic_off", 0xe02b);
export const Money = makeIcon("payments", 0xef63);
export const NotePencil = makeIcon("edit_note", 0xe745);
export const Notebook = makeIcon("note_alt", 0xf040);
export const Package = makeIcon("inventory_2", 0xe1a1);
export const PaperPlaneTilt = makeIcon("send", 0xe163);
export const Pause = makeIcon("pause", 0xe034);
export const PencilSimple = makeIcon("edit", 0xf097);
export const Phone = makeIcon("call", 0xf0d4);
export const Play = makeIcon("play_arrow", 0xe037);
export const Plus = makeIcon("add", 0xe145);
export const Prohibit = makeIcon("block", 0xf08c);
export const PushPin = makeIcon("push_pin", 0xf10d);
export const Question = makeIcon("help", 0xe8fd);
export const Quotes = makeIcon("format_quote", 0xe244);
export const Radio = makeIcon("radio", 0xe03e);
export const Robot = makeIcon("smart_toy", 0xf06c);
export const Scales = makeIcon("balance", 0xeaf6);
export const SealCheck = makeIcon("verified", 0xef76);
export const ShareNetwork = makeIcon("share", 0xe80d);
export const ShieldCheck = makeIcon("verified_user", 0xf013);
export const ShieldWarning = makeIcon("gpp_maybe", 0xf014);
export const SignOut = makeIcon("logout", 0xe9ba);
export const Sliders = makeIcon("tune", 0xe429);
export const SlidersHorizontal = makeIcon("tune", 0xe429);
export const Sparkle = makeIcon("auto_awesome", 0xe65f);
export const Square = makeIcon("stop", 0xe047);
export const SquaresFour = makeIcon("grid_view", 0xe9b0);
export const StackPlus = makeIcon("library_add", 0xe03c);
export const Star = makeIcon("star", 0xf09a);
export const Storefront = makeIcon("storefront", 0xea12);
export const Ticket = makeIcon("confirmation_number", 0xe638);
export const Timer = makeIcon("timer", 0xe425);
export const Trash = makeIcon("delete", 0xe92e);
export const TrendUp = makeIcon("trending_up", 0xe8e5);
export const UploadSimple = makeIcon("upload", 0xf09b);
export const User = makeIcon("person", 0xf0d3);
export const UserCheck = makeIcon("how_to_reg", 0xe174);
export const UserCircle = makeIcon("account_circle", 0xf20b);
export const UserMinus = makeIcon("person_remove", 0xef66);
export const UserPlus = makeIcon("person_add", 0xea4d);
export const Users = makeIcon("group", 0xea21);
export const UsersThree = makeIcon("groups", 0xf233);
export const VideoCameraSlash = makeIcon("videocam_off", 0xe04c);
export const Wallet = makeIcon("account_balance_wallet", 0xe850);
export const Warning = makeIcon("warning", 0xf083);
export const WifiSlash = makeIcon("wifi_off", 0xe648);
export const Wrench = makeIcon("build", 0xf8cd);
export const X = makeIcon("close", 0xe5cd);
export const XCircle = makeIcon("cancel", 0xe888);

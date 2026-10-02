/**
 * 设计原语统一出口。
 *
 * 约定：上层代码只从 "@/design/primitives" 引入，不要深入到具体文件。
 * 这样将来把一个原语拆成多个文件、或替换实现时，调用方零改动。
 * Modal 底座是内部实现细节，不在这里导出。
 */

// ---- 无障碍基座（T1.8） ----
export {
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  reduceDuration,
  motionPolicy,
} from "./reducedMotion";
export type { MotionPolicy, MatchMediaLike } from "./reducedMotion";

export {
  FOCUSABLE_SELECTOR,
  isFocusable,
  isProgrammaticallyFocusable,
  getFocusableElements,
  focusableCandidates,
  focusTrap,
} from "./focusTrap";
export type { FocusTrapOptions, FocusTrapCleanup } from "./focusTrap";

export {
  axisDelta,
  isEdgeKey,
  nextIndexFor,
  handleListNavigation,
  applyRovingTabindex,
} from "./keyboardNav";
export type { NavigationAxis, ListNavigationOptions } from "./keyboardNav";

export {
  PRIMITIVES_CSS,
  ensurePrimitivesStyle,
  usePrimitivesStyle,
  cx,
} from "./styles";

// ---- 基础原语（T1.4） ----
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { IconButton } from "./IconButton";
export type { IconButtonProps, IconButtonSize } from "./IconButton";

export { Input } from "./Input";
export type { InputProps } from "./Input";

export { Textarea } from "./Textarea";
export type { TextareaProps } from "./Textarea";

export { Select } from "./Select";
export type { SelectProps, SelectOption } from "./Select";

export { Checkbox } from "./Checkbox";
export type { CheckboxProps } from "./Checkbox";

export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";

export { Tooltip } from "./Tooltip";
export type { TooltipProps, TooltipPlacement } from "./Tooltip";

// ---- 容器原语（T1.5） ----
export { Dialog } from "./Dialog";
export type { DialogProps } from "./Dialog";

export { Drawer } from "./Drawer";
export type { DrawerProps, DrawerSide } from "./Drawer";

export { Popover } from "./Popover";
export type { PopoverProps, PopoverPlacement } from "./Popover";

export { Menu, MenuItem, MenuSeparator, MenuList } from "./Menu";
export type { MenuProps, MenuItemProps, MenuListProps } from "./Menu";

export {
  Toast,
  ToastRegion,
  pushToast,
  dismissToast,
  clearToasts,
  toasts,
  toast,
  resetToastStore,
} from "./Toast";
export type {
  ToastProps,
  ToastRegionProps,
  ToastItem,
  ToastTone,
  ToastPlacement,
} from "./Toast";

export { Tabs } from "./Tabs";
export type { TabsProps, TabItem } from "./Tabs";

export { ScrollArea, scrollToBottom } from "./ScrollArea";
export type {
  ScrollAreaProps,
  ScrollInfo,
  ScrollOrientation,
} from "./ScrollArea";

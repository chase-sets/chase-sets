import type { ComponentPropsWithRef, ComponentPropsWithoutRef, ElementType, ReactElement, Ref } from "react";

export type PolymorphicRef<TTarget extends ElementType> =
  ComponentPropsWithRef<TTarget> extends { ref?: Ref<infer TInstance> | undefined } ? TInstance : never;

export type PolymorphicProps<TTarget extends ElementType, TOwnProps> = TOwnProps &
  Omit<ComponentPropsWithoutRef<TTarget>, keyof TOwnProps | "as" | "render" | "className" | "style"> & {
    as?: TTarget;
    render?: TTarget;
  };

export type PolymorphicPrimitive<TOwnProps, TDefaultTarget extends ElementType> = <
  TTarget extends ElementType = TDefaultTarget,
>(
  props: PolymorphicProps<TTarget, TOwnProps> & { ref?: Ref<PolymorphicRef<TTarget>> },
) => ReactElement | null;

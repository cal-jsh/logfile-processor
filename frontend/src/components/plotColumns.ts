/*
 * Shared horizontal layout of the minimap and the thread lanes, so their plots line up
 * pixel for pixel: a name column on the left, the plot, and a column on the right as wide
 * as the log's scrollbar (the lanes' own vertical scrollbar sits in it, see `.lanes-scroll`
 * in index.css). Both plots then span the same x range at every window width.
 */

/** css px, the name column left of a plot (lane names, minimap label) */
export const LABEL_W = 132;
/** css px, the column right of a plot: the width of the log's and the lanes' scrollbars */
export const END_W = 12;

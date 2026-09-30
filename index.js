/** Host half of the cost-meter bundle. The Client module owns every visible
 * surface and reads only the existing `tokenUsage` and `modelSelection`
 * session projections, so the Host half has nothing to register. */
export function apply() {}

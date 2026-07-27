import { ResourcePath } from "./resource.path.js";

export interface ISlotResourceResolver {
    resolve(slot: string): ResourcePath | undefined;
}

const RESERVED_RESOURCES: Readonly<Record<string, string>> = {
    _broker: "/_system/broker",
    _all: "/_system/all",
};

function isReservedNamespace(resource: ResourcePath): boolean {
    return resource.value === "/_system" || resource.value.startsWith("/_system/");
}

/** Default resolver with optional explicit technical-slot mappings. */
export class DefaultSlotResourceResolver implements ISlotResourceResolver {
    private readonly _explicit = new Map<string, ResourcePath>();

    constructor(slotResources: Readonly<Record<string, string>> = {}) {
        for (const [slot, configuredPath] of Object.entries(slotResources)) {
            if (!slot) throw new Error("authorization slotResources: slot names must not be empty.");
            const resource = ResourcePath.parse(configuredPath);
            const reserved = RESERVED_RESOURCES[slot];
            if (isReservedNamespace(resource) && reserved !== resource.value) {
                throw new Error(`authorization slotResources: slot "${slot}" may not use reserved resource "${resource.value}".`);
            }
            if (reserved && resource.value !== reserved) {
                throw new Error(`authorization slotResources: reserved slot "${slot}" must resolve to "${reserved}".`);
            }
            this._explicit.set(slot, resource);
        }
    }

    resolve(slot: string): ResourcePath | undefined {
        const explicit = this._explicit.get(slot);
        if (explicit) return explicit;

        const reserved = RESERVED_RESOURCES[slot];
        if (reserved) return ResourcePath.parse(reserved);
        if (!slot) return undefined;

        const candidate = slot.startsWith("/") ? slot : `/${slot}`;
        const resource = ResourcePath.tryParse(candidate);
        return resource && !isReservedNamespace(resource) ? resource : undefined;
    }
}

/** @deprecated Use {@link ISlotResourceResolver}. */
export type SlotResourceResolver = ISlotResourceResolver;

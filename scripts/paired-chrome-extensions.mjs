import assert from 'node:assert/strict';

// Read-only WebUI state. The manager's canLoadUnpacked starts false and is set
// only by Chrome's profile callback, so default policy=false is not readiness.
export function readDeveloperModeDomState() {
    const manager = document.querySelector('extensions-manager');
    const toolbar = manager?.shadowRoot?.querySelector('extensions-toolbar');
    const toggle = toolbar?.shadowRoot?.querySelector('#devMode');
    return {
        url: location.href,
        manager: manager ? { canLoadUnpacked: manager.canLoadUnpacked, inDevMode: manager.inDevMode,
            policy: manager.devModeControlledByPolicy, child: manager.isChildAccount_ } : null,
        toolbar: toolbar ? { canLoadUnpacked: toolbar.canLoadUnpacked, inDevMode: toolbar.inDevMode,
            policy: toolbar.devModeControlledByPolicy, child: toolbar.isChildAccount } : null,
        toggle: toggle ? { checked: toggle.checked, disabled: toggle.disabled,
            ariaChecked: toggle.getAttribute('aria-checked'), ariaDisabled: toggle.getAttribute('aria-disabled') } : null
    };
}

export function developerModeStateReady(state) {
    assert.equal(state?.url, 'chrome://extensions/', 'Developer mode may only be configured on the normal Chrome Extensions page.');
    for (const part of [state.manager, state.toolbar]) {
        assert.notEqual(part?.policy, true, 'Developer mode is policy-controlled; stop without changing it.');
        assert.notEqual(part?.child, true, 'Developer mode is restricted for a child account; stop.');
    }
    assert.notEqual(state.toggle?.disabled, true, 'Developer mode toggle is disabled; stop.');
    assert.notEqual(state.toggle?.ariaDisabled, 'true', 'Developer mode toggle reports disabled; stop.');
    const { manager, toolbar, toggle } = state;
    return manager?.canLoadUnpacked === true && toolbar?.canLoadUnpacked === true &&
        manager.policy === false && toolbar.policy === false && manager.child === false && toolbar.child === false &&
        typeof manager.inDevMode === 'boolean' && toolbar.inDevMode === manager.inDevMode &&
        toggle?.checked === manager.inDevMode && toggle.disabled === false &&
        toggle.ariaChecked === String(manager.inDevMode) && toggle.ariaDisabled === 'false';
}

// Exactly one normal UI click, never a preference write or private API call.
export async function enableDeveloperModeViaUi({ read, click, record }, {
    timeout = 20_000, interval = 100, now = Date.now,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
    async function wait(phase, requireEnabled) {
        const deadline = now() + timeout;
        let state;
        do {
            state = await read();
            await record({ phase, state });
            if (developerModeStateReady(state) && (!requireEnabled || state.manager.inDevMode)) return state;
            if (now() >= deadline) break;
            await sleep(interval);
        } while (now() < deadline);
        throw new Error(`Developer mode ${phase} did not reach an enabled, unmanaged profile state: ${JSON.stringify(state)}`);
    }
    await wait('before-click', false);
    // Recheck after the readiness wait, directly before the sole UI action.
    const latest = await read();
    await record({ phase: 'pre-click-recheck', state: latest });
    assert(developerModeStateReady(latest), 'Developer mode became unavailable before its UI click; stop.');
    if (latest.manager.inDevMode) return { clicked: false, state: latest };
    await click();
    return { clicked: true, state: await wait('after-click', true) };
}

export function findInstalledExtension(extensions, expected, { allowMissing = false } = {}) {
    assert(Array.isArray(extensions), 'Chrome must return its real installed extension registry.');
    const matches = extensions.filter(extension => extension.id === expected.id);
    if (allowMissing && matches.length === 0) return null;
    assert.equal(matches.length, 1, 'Exactly one installed extension must match the expected ID.');
    const actual = matches[0];
    for (const field of ['name', 'version', 'path']) assert.equal(actual[field], expected[field], `Installed extension ${field} must remain unchanged.`);
    assert.equal(typeof actual.enabled, 'boolean', 'Chrome must report enabled state explicitly.');
    return actual;
}

// Read-only convergence after a proven unload. Never repeat reload, reinstall,
// enable a disabled extension, or navigate a blocked URL to force convergence.
export async function waitForEnabledExtension(read, expected, record, {
    timeout = 20_000, interval = 100, now = Date.now,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
    const deadline = now() + timeout;
    let last;
    do {
        last = await read();
        await record(last);
        const actual = findInstalledExtension(last, expected, { allowMissing: true });
        if (actual?.enabled) return actual;
        if (now() >= deadline) break;
        await sleep(interval);
    } while (now() < deadline);
    throw new Error(`Reloaded extension did not become enabled; stop without a policy workaround: ${JSON.stringify(last)}`);
}

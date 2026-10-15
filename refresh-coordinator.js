export class RefreshCoordinator {
    constructor({ readSpaces, adoptSpaces, render, isBusy = () => false, onError = () => {}, delay = 100, maxRetries = 3,
        schedule = (callback, timeout) => globalThis.setTimeout(callback, timeout),
        cancel = timer => globalThis.clearTimeout(timer) }) {
        this.readSpaces = readSpaces;
        this.adoptSpaces = adoptSpaces;
        this.render = render;
        this.isBusy = isBusy;
        this.onError = onError;
        this.delay = delay;
        this.maxRetries = maxRetries;
        this.scheduleFn = schedule;
        this.cancelFn = cancel;
        this.bookmarkGeneration = 0;
        this.handledBookmarkGeneration = 0;
        this.spacesGeneration = 0;
        this.handledSpacesGeneration = 0;
        this.activeViewGeneration = 0;
        this.handledActiveViewGeneration = 0;
        this.renderDirty = false;
        this.running = false;
        this.timer = null;
        this.retryCount = 0;
    }

    invalidateBookmarks() {
        this.bookmarkGeneration++;
        this.retryCount = 0;
        this.schedule();
    }

    invalidateSpaces() {
        this.spacesGeneration++;
        this.retryCount = 0;
        this.schedule();
    }

    invalidateActiveView() {
        this.activeViewGeneration++;
        this.retryCount = 0;
        this.schedule();
    }

    get spacesDirty() {
        return this.spacesGeneration > this.handledSpacesGeneration;
    }

    hasWork() {
        return this.renderDirty || this.spacesDirty || this.bookmarkGeneration > this.handledBookmarkGeneration ||
            this.activeViewGeneration > this.handledActiveViewGeneration;
    }

    schedule(delay = this.delay) {
        if (this.timer !== null) this.cancelFn(this.timer);
        this.timer = this.scheduleFn(() => {
            this.timer = null;
            return this.drain().catch(this.onError);
        }, delay);
    }

    retry() {
        this.retryCount = 0;
        this.schedule();
    }

    async drain() {
        if (this.running) return;
        if (!this.hasWork()) return;
        if (this.isBusy()) return;

        this.running = true;
        const generation = this.bookmarkGeneration;
        const spacesGeneration = this.spacesGeneration;
        const activeViewGeneration = this.activeViewGeneration;
        // A render must not commit or acknowledge work superseded while it awaited
        // storage, bookmark trees, or tabs. Busy work is resumed by its idle hook.
        const isCurrent = () => !this.isBusy() && generation === this.bookmarkGeneration &&
            spacesGeneration === this.spacesGeneration && activeViewGeneration === this.activeViewGeneration;
        let failed = false;
        try {
            const next = await this.readSpaces();
            if (!isCurrent()) return;
            const adoption = await this.adoptSpaces(next);
            if (adoption?.completed === false) return;
            this.renderDirty ||= Boolean(typeof adoption === 'object' ? adoption.needsRender : adoption);
            if (!isCurrent()) return;
            if (this.renderDirty || generation > this.handledBookmarkGeneration ||
                activeViewGeneration > this.handledActiveViewGeneration) {
                const renderCompleted = await this.render({ isCurrent,
                    activeViewChanged: activeViewGeneration > this.handledActiveViewGeneration });
                if (renderCompleted === false || !isCurrent()) return;
            }
            this.renderDirty = false;
            this.handledSpacesGeneration = spacesGeneration;
            this.handledBookmarkGeneration = generation;
            this.handledActiveViewGeneration = activeViewGeneration;
            this.retryCount = 0;
        } catch (error) {
            failed = true;
            this.onError(error);
            if (this.retryCount < this.maxRetries) {
                const retryDelay = this.delay * (2 ** this.retryCount);
                this.retryCount++;
                this.schedule(retryDelay);
            }
        } finally {
            this.running = false;
            // Include early exits: a queued wake may already have fired during the
            // previous drain and found it running. Never lose that newer work.
            if (!failed && !this.isBusy() && this.hasWork()) this.schedule();
        }
    }
}

import { useRef } from 'react'
import { useMountEffect } from '../../hooks/use-mount-effect'
import { boardDeliveryAlertLabel, boardDeliveryLabel, boardIdleBackground, boardStatusLabel, formatBoardUpdateTime } from '../../lib/task-board'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../context-menu'
import { SessionLabelBadge } from '../session-label-badge'
import { renderSessionStatusIndicator, UnreadBullet } from '../sidebar/status-indicators'
import type {
  KanbanBoardProps,
  KanbanCard as KanbanCardModel,
  KanbanCardProps,
  KanbanColumnProps,
  KanbanOwner,
} from './types'

/**
 * Pure presentational kanban card.
 *
 * Renders owner avatar/initials, title, workflow badge, live status indicator,
 * and (when present) an unresolved-comment indicator. No business logic, no
 * queries — the wired layer (`WiredKanbanCard`) supplies comment/focus data.
 */
export function KanbanCard({
  card,
  nowMs = Date.now(),
  isFocused,
  onMouseEnter,
  onClick,
  onCreateSession,
  onArchiveTask,
  onRenameTask,
  onCopyTaskUrl,
  onForceArchiveTask,
  onForceRenameTask,
}: KanbanCardProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Scroll a card that mounts focused into view. Callers must key this
  // component by focus state (see WiredKanbanCard) so that gaining focus
  // re-mounts the card and re-runs this — keyboard navigation then scrolls
  // without a reactive effect.
  useMountEffect(() => {
    if (isFocused) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })

  const cardRoot = (
    <div
      ref={ref}
      data-kanban-task-id={card.id}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`cursor-pointer border-l-2 p-3 transition-colors duration-200 ${
        isFocused ? 'border-l-[var(--terminal-accent)] bg-accent/10' : 'border-l-transparent bg-accent/5 hover:bg-accent/10'
      }`}
      style={{
        fontFamily: '"IBM Plex Mono", monospace',
        borderRadius: 0,
        backgroundColor: boardIdleBackground(card.status, card.updatedAtMs, nowMs),
      }}
    >
      <KanbanCardContent card={card} nowMs={nowMs} />
    </div>
  )

  // Only wrap in a right-click context menu when a handler is supplied, so pure
  // stories and other callers that omit them render exactly as before.
  if (
    onCreateSession === null &&
    !onArchiveTask &&
    !onRenameTask &&
    !onCopyTaskUrl &&
    onForceArchiveTask === null &&
    onForceRenameTask === null
  ) {
    return cardRoot
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{cardRoot}</ContextMenuTrigger>
      <ContextMenuContent className="w-fit">
        {onCreateSession !== null && (
          <ContextMenuItem className="whitespace-nowrap" onSelect={() => onCreateSession(card.id)}>
            Create Session
          </ContextMenuItem>
        )}
        {onCopyTaskUrl && (
          <ContextMenuItem className="whitespace-nowrap" onSelect={() => onCopyTaskUrl(card.id)}>
            Copy Task URL
          </ContextMenuItem>
        )}
        {onRenameTask && (
          <ContextMenuItem className="whitespace-nowrap" onSelect={() => onRenameTask(card.id)}>
            Rename
          </ContextMenuItem>
        )}
        {onArchiveTask && (
          <ContextMenuItem className="whitespace-nowrap" onSelect={() => onArchiveTask(card.id)}>
            Archive
          </ContextMenuItem>
        )}
        {onForceArchiveTask !== null && (
          <ContextMenuItem
            variant="destructive"
            className="whitespace-nowrap"
            onSelect={() => onForceArchiveTask(card.id)}
          >
            Archive
          </ContextMenuItem>
        )}
        {onForceRenameTask !== null && (
          <ContextMenuItem
            variant="destructive"
            className="whitespace-nowrap"
            onSelect={() => onForceRenameTask(card.id)}
          >
            Rename
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function KanbanCardContent({ card, nowMs }: { card: KanbanCardModel; nowMs: number }) {
  const owners = card.owners && card.owners.length > 0 ? card.owners : [{ initials: card.ownerInitials, avatarUrl: card.ownerAvatarUrl }]
  const updated = card.updatedAtMs === undefined ? null : formatBoardUpdateTime(card.updatedAtMs, nowMs)
  const status = card.status ?? (card.isDraft ? 'draft' : 'not_started')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <span
          className="line-clamp-2 min-w-0 flex-1 text-sm leading-tight [overflow-wrap:anywhere]"
          title={card.title}
          style={{ color: 'var(--terminal-fg)' }}
        >
          {card.title}
        </span>
        <OwnerAvatarStack owners={owners} />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {card.isDraft ? (
            <SessionLabelBadge label={{ name: 'rpi:todo', title: 'draft' }} />
          ) : (
            <SessionLabelBadge label={card.workflowLabel} />
          )}
        </div>

        <div className="flex items-center gap-2">
          {card.isUnread === true && <UnreadBullet />}

          {card.commentCount !== undefined && card.commentCount > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="flex -space-x-1.5">
                {(card.commenters ?? []).slice(0, 3).map((commenter, i) => (
                  <img
                    // biome-ignore lint/suspicious/noArrayIndexKey: commenter avatars are positional
                    key={i}
                    src={commenter.avatarUrl}
                    alt={commenter.name}
                    className="h-4 w-4 object-cover"
                    style={{ border: '1px solid var(--terminal-bg)' }}
                  />
                ))}
              </div>
              <span className="text-xs" style={{ color: 'var(--terminal-fg-dim)' }}>
                {card.commentCount}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true">{renderSessionStatusIndicator(status)}</span>
          {card.delivery ? boardDeliveryLabel(card.delivery) : boardStatusLabel(status)}
        </span>
        {updated && (
          <time className="text-[var(--terminal-fg-dim)]" dateTime={updated.dateTime} title={updated.full}>
            Updated {updated.label}
          </time>
        )}
      </div>
      {card.delivery?.status === 'blocked' && (
        <p className="break-words text-xs">{card.delivery.reason}<br />{boardDeliveryAlertLabel(card.delivery)}</p>
      )}
    </div>
  )
}

function OwnerAvatarStack({ owners }: { owners: KanbanOwner[] }) {
  const visibleOwners = owners.slice(0, 3)
  const extraCount = Math.max(owners.length - visibleOwners.length, 0)

  return (
    <div className="flex shrink-0 -space-x-1.5" aria-label={`${owners.length} task owner${owners.length === 1 ? '' : 's'}`}>
      {visibleOwners.map((owner, index) =>
        owner.avatarUrl ? (
          <img
            key={owner.id ?? `${owner.initials}-${index}`}
            src={owner.avatarUrl}
            alt={owner.initials}
            className="h-6 w-6 shrink-0 object-cover"
            style={{ border: '1px solid var(--terminal-bg)' }}
          />
        ) : (
          <div
            key={owner.id ?? `${owner.initials}-${index}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center text-xs font-medium"
            style={{
              backgroundColor: 'var(--terminal-bg-alt)',
              border: '1px solid var(--terminal-border)',
              color: 'var(--terminal-fg)',
            }}
          >
            {owner.initials}
          </div>
        ),
      )}
      {extraCount > 0 && (
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center text-[10px] font-medium"
          style={{
            backgroundColor: 'var(--terminal-bg-alt)',
            border: '1px solid var(--terminal-border)',
            color: 'var(--terminal-fg-dim)',
          }}
        >
          +{extraCount}
        </div>
      )}
    </div>
  )
}

/**
 * Pure column shell: a header (title + count badge) over a vertical, scrollable
 * stack of cards passed as `children`. Card composition is owned by the caller,
 * so wired callers can pass connected cards without a render-prop.
 */
export function KanbanColumn({ title, description, count, children }: KanbanColumnProps) {
  return (
    <div className="flex h-full min-w-72 flex-1 flex-col" style={{ fontFamily: '"IBM Plex Mono", monospace' }}>
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--terminal-fg)' }}>
          {title}
        </h3>
        <span
          className="flex h-5 min-w-5 items-center justify-center px-1 text-xs"
          style={{
            backgroundColor: 'var(--terminal-bg)',
            color: 'var(--terminal-fg-dim)',
          }}
        >
          {count}
        </span>
      </div>
      {description && <p className="px-2 pb-3 text-xs text-[var(--terminal-fg-dim)]">{description}</p>}

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 py-0.5">{children}</div>
    </div>
  )
}

/**
 * Pure read-only kanban board: a horizontal, scrollable row of {@link KanbanColumn}
 * shells passed as `children`. Layout only — no data, no drag, no state. The wired
 * layer (`WiredBoardTasksView`) composes columns and cards from `useKanbanColumns`.
 */
export function KanbanBoard({ children }: KanbanBoardProps) {
  return (
    <div
      className="flex h-full gap-2 overflow-x-auto p-4"
      style={{ backgroundColor: 'var(--terminal-bg)', fontFamily: '"IBM Plex Mono", monospace' }}
    >
      {children}
    </div>
  )
}

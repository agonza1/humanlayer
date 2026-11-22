ALTER TABLE "tasks" ADD COLUMN "implementation_reconciliation" jsonb;
--> statement-breakpoint
-- NOTIFY only publishes after commit. No task data or credentials travel in the event.
CREATE FUNCTION notify_implementation_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before_row jsonb;
  after_row jsonb;
  source_row jsonb;
  payload jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_row := to_jsonb(NEW); END IF;
  source_row := COALESCE(after_row, before_row);

  CASE TG_TABLE_NAME
    WHEN 'tasks' THEN
      IF TG_OP = 'UPDATE' AND
        (before_row - ARRAY['updated_at', 'name', 'slug', 'implementation_reconciliation'])
        IS NOT DISTINCT FROM
        (after_row - ARRAY['updated_at', 'name', 'slug', 'implementation_reconciliation'])
      THEN
        IF before_row->'implementation_reconciliation'->'wakeAt'
          IS DISTINCT FROM after_row->'implementation_reconciliation'->'wakeAt'
        THEN PERFORM pg_notify('riptide_implementation_reconciliation', 'deadline'); END IF;
        RETURN NULL;
      END IF;
      payload := jsonb_build_object('scope', 'task',
        'organizationId', source_row->>'organization_id', 'taskId', source_row->>'id');
    WHEN 'online_hosts' THEN
      IF TG_OP = 'UPDATE' AND before_row->'status' IS NOT DISTINCT FROM after_row->'status'
        AND (after_row->>'last_seen')::bigint - (before_row->>'last_seen')::bigint < 120000
      THEN RETURN NULL; END IF;
      payload := jsonb_build_object('scope', 'host', 'organizationId', source_row->>'organization_id',
        'hostId', source_row->>'host_id', 'ownerId', source_row->>'user_id');
    WHEN 'workspaces', 'workspace_repository_status_for_user_for_host' THEN
      payload := jsonb_build_object('scope', 'workspace', 'organizationId', source_row->>'organization_id',
        'workspaceId', CASE WHEN TG_TABLE_NAME = 'workspaces' THEN source_row->>'id'
                           ELSE source_row->>'workspace_id' END);
    WHEN 'project' THEN
      payload := jsonb_build_object('scope', 'project', 'organizationId', source_row->>'organization_id',
        'projectId', source_row->>'id');
    WHEN 'pull_requests' THEN
      IF TG_OP = 'UPDATE' AND
        (before_row->'task_id', before_row->'head_ref', before_row->'base_ref', before_row->'head_sha',
          before_row->'state', before_row->'is_draft')
        IS NOT DISTINCT FROM
        (after_row->'task_id', after_row->'head_ref', after_row->'base_ref', after_row->'head_sha',
          after_row->'state', after_row->'is_draft')
      THEN RETURN NULL; END IF;
      IF source_row->>'task_id' IS NOT NULL THEN
        PERFORM pg_notify('riptide_implementation_reconciliation', jsonb_build_object('scope', 'task',
          'organizationId', source_row->>'organization_id', 'taskId', source_row->>'task_id')::text);
      END IF;
      payload := jsonb_build_object('scope', 'branch', 'organizationId', source_row->>'organization_id',
        'repository', source_row->>'repo_full_name', 'branch', source_row->>'head_ref');
    ELSE
      IF source_row->>'task_id' IS NULL THEN RETURN NULL; END IF;
      payload := jsonb_build_object('scope', 'task',
        'organizationId', source_row->>'organization_id', 'taskId', source_row->>'task_id');
  END CASE;
  IF octet_length(payload::text) < 8000 THEN
    PERFORM pg_notify('riptide_implementation_reconciliation', payload::text);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_task_policy
  AFTER UPDATE OF archived, is_draft, resource_owner_user_id, workspace_id, project_id, ticket_description,
    automatic_delivery, delivery_snapshot, auto_advance_implementation_to_pr, slack_notifications_muted,
    implementation_reconciliation
  ON tasks FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_session_insert_delete
  AFTER INSERT OR DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_session_work
  AFTER UPDATE OF task_id, archived, status, labels, host_id, working_directory, prompt, next_step_suggestions
  ON sessions FOR EACH ROW
  WHEN ((OLD.task_id, OLD.archived, OLD.status, OLD.labels, OLD.host_id, OLD.working_directory,
    OLD.prompt, OLD.next_step_suggestions) IS DISTINCT FROM
    (NEW.task_id, NEW.archived, NEW.status, NEW.labels, NEW.host_id, NEW.working_directory,
    NEW.prompt, NEW.next_step_suggestions))
  EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_session_queue
  AFTER INSERT OR UPDATE OF status OR DELETE ON queued_messages
  FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_repository
  AFTER INSERT OR UPDATE OF is_head, host_id, local_path, remote_url, repo_full_name, branch OR DELETE
  ON session_repositories FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_github
  AFTER INSERT OR UPDATE OF task_id, head_ref, base_ref, head_sha, state, is_draft OR DELETE
  ON pull_requests FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_commit
  AFTER INSERT ON commits FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_host
  AFTER INSERT OR UPDATE OF status, last_seen OR DELETE ON online_hosts
  FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_workspace
  AFTER UPDATE OF repositories, archived, resource_owner_user_id ON workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_workspace_status
  AFTER INSERT OR UPDATE OF materialization, status, repo_available, error OR DELETE
  ON workspace_repository_status_for_user_for_host FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_project
  AFTER UPDATE OF repositories, archived ON project
  FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();
--> statement-breakpoint
CREATE TRIGGER reconcile_implementation_user_settings
  AFTER INSERT OR UPDATE OF auto_advance_implementation_to_pr OR DELETE ON task_user_settings
  FOR EACH ROW EXECUTE FUNCTION notify_implementation_reconciliation();

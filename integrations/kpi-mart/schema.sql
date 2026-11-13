-- FDE local KPI mart, schema v1.
-- Synthetic native-source reporting demonstration; no ERP/MES DB writes.
-- PostgreSQL 17, loopback-only service. All sources remain source-labelled.
BEGIN;
CREATE SCHEMA IF NOT EXISTS mart;

CREATE TABLE IF NOT EXISTS mart.refresh_run (
  run_id text PRIMARY KEY CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$'),
  native_source_run_id text NOT NULL,
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  kernel_sha256 char(64) NOT NULL CHECK (kernel_sha256 ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  as_of_date date NOT NULL,
  state text NOT NULL DEFAULT 'loading' CHECK (state IN ('loading','accepted','refused')),
  source_data_class text NOT NULL CHECK (source_data_class = 'SYNTHETIC_LAB_NATIVE_OBSERVATIONS_AND_EXPLICIT_SCENARIO_VALUES'),
  calendar_status text NOT NULL DEFAULT 'PROVISIONAL_CALENDAR_MONTHS',
  target_status text NOT NULL DEFAULT 'SYNTHETIC_NOT_BUSINESS_APPROVED',
  source_inventory jsonb NOT NULL,
  output_inventory jsonb,
  CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS mart.calendar_day (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  work_date date NOT NULL,
  period_key text NOT NULL CHECK (period_key ~ '^[0-9]{4}-[0-9]{2}$'),
  scheduled boolean NOT NULL,
  holiday_state text NOT NULL,
  fiscal_year smallint NOT NULL,
  fiscal_period smallint NOT NULL CHECK (fiscal_period BETWEEN 1 AND 13),
  calendar_version text NOT NULL,
  PRIMARY KEY(run_id,work_date)
);
CREATE INDEX IF NOT EXISTS calendar_run_period ON mart.calendar_day(run_id,period_key);

CREATE TABLE IF NOT EXISTS mart.kpi_target (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  period_key text NOT NULL,
  department text NOT NULL CHECK (department IN ('Production','Quality','Safety','Maintenance')),
  metric_id text NOT NULL,
  target_value numeric(18,6),
  status text NOT NULL CHECK (status = 'SYNTHETIC_NOT_BUSINESS_APPROVED'),
  PRIMARY KEY(run_id,period_key,department,metric_id)
);

CREATE TABLE IF NOT EXISTS mart.source_shift (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  work_date date NOT NULL,
  period_key text NOT NULL,
  line_code text NOT NULL,
  erp_work_order text NOT NULL,
  mes_work_order text NOT NULL,
  planned_units numeric(14,3) NOT NULL CHECK (planned_units >= 0),
  scenario_good_units numeric(14,3) NOT NULL CHECK (scenario_good_units >= 0),
  scenario_reject_units numeric(14,3) NOT NULL CHECK (scenario_reject_units >= 0),
  scenario_unfinished_units numeric(14,3) NOT NULL CHECK (scenario_unfinished_units >= 0),
  mes_produced_units numeric(14,3) NOT NULL CHECK (mes_produced_units >= 0),
  qc_sample_count integer NOT NULL CHECK (qc_sample_count >= 0),
  qc_passed_count integer NOT NULL CHECK (qc_passed_count BETWEEN 0 AND qc_sample_count),
  qc_check_count integer NOT NULL CHECK (qc_check_count >= 0),
  data_class text NOT NULL CHECK (data_class='SYNTHETIC_SCENARIO'),
  PRIMARY KEY(run_id, work_date, line_code),
  UNIQUE(run_id,erp_work_order),
  UNIQUE(run_id,mes_work_order),
  FOREIGN KEY(run_id,work_date) REFERENCES mart.calendar_day(run_id,work_date),
  CHECK (planned_units=scenario_good_units+scenario_reject_units+scenario_unfinished_units)
);
CREATE INDEX IF NOT EXISTS source_shift_period_idx ON mart.source_shift(run_id,period_key);

CREATE TABLE IF NOT EXISTS mart.source_exposure (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  work_date date NOT NULL,
  period_key text NOT NULL,
  exposure_hours numeric(15,3) NOT NULL CHECK (exposure_hours>=0),
  worker_count integer NOT NULL CHECK (worker_count>=0),
  coverage text NOT NULL,
  PRIMARY KEY(run_id,work_date),
  FOREIGN KEY(run_id,work_date) REFERENCES mart.calendar_day(run_id,work_date)
);
CREATE TABLE IF NOT EXISTS mart.source_ehs_event (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  event_key text NOT NULL,
  occurred_date date NOT NULL,
  period_key text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('Incident','Near Miss','Observation')),
  lost_days integer NOT NULL CHECK (lost_days>=0),
  action_status text NOT NULL,
  legal_reportability text NOT NULL DEFAULT 'NOT_ASSESSED_SYNTHETIC',
  PRIMARY KEY(run_id,event_key)
);

CREATE TABLE IF NOT EXISTS mart.source_maintenance (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  source_title text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('planned','corrective','inspection')),
  source_status text NOT NULL,
  scheduled_date date,
  completed_date date,
  workstation_code text,
  PRIMARY KEY(run_id,source_title)
);
CREATE INDEX IF NOT EXISTS maintenance_run_due ON mart.source_maintenance(run_id,scheduled_date);
CREATE TABLE IF NOT EXISTS mart.source_downtime (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  source_notes text NOT NULL,
  work_date date NOT NULL,
  reason_id integer NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes >= 0),
  PRIMARY KEY(run_id,source_notes)
);

CREATE TABLE IF NOT EXISTS mart.kpi_definition (
  metric_id text PRIMARY KEY,
  department text NOT NULL CHECK (department IN ('Production','Quality','Safety','Maintenance')),
  display_name text NOT NULL,
  numerator_description text,
  denominator_description text,
  unit text NOT NULL,
  calculation_owner text NOT NULL,
  formula_version text NOT NULL,
  interpretation_note text NOT NULL,
  live_plant_certified boolean NOT NULL DEFAULT false CHECK (live_plant_certified=false)
);

CREATE TABLE IF NOT EXISTS mart.kpi_result (
  run_id text NOT NULL REFERENCES mart.refresh_run(run_id),
  grain text NOT NULL CHECK (grain IN ('day','month')),
  period_key text NOT NULL,
  department text NOT NULL CHECK (department IN ('Production','Quality','Safety','Maintenance')),
  metric_id text NOT NULL REFERENCES mart.kpi_definition(metric_id),
  numerator numeric(20,6),
  denominator numeric(20,6),
  metric_value numeric(20,6),
  unit text NOT NULL,
  formula_version text NOT NULL,
  calculation_owner text NOT NULL,
  status text NOT NULL CHECK (status IN ('calculated-synthetic','native-reported','unknown-denominator','not-due')),
  interpretation_note text NOT NULL,
  PRIMARY KEY(run_id,grain,period_key,metric_id),
  CHECK (denominator IS NULL OR denominator>=0),
  CHECK (denominator IS DISTINCT FROM 0 OR metric_value IS NULL)
);
CREATE INDEX IF NOT EXISTS kpi_period_lookup ON mart.kpi_result(run_id,grain,period_key,department);

-- Latest complete, accepted refresh only. No half-written result appears in Excel.
CREATE OR REPLACE VIEW mart.v_latest_refresh AS
 SELECT * FROM mart.refresh_run WHERE state='accepted'
 ORDER BY accepted_at DESC,run_id DESC LIMIT 1;

CREATE OR REPLACE VIEW mart.v_source_shifts AS
 SELECT s.* FROM mart.source_shift s JOIN mart.v_latest_refresh r USING(run_id);

CREATE OR REPLACE VIEW mart.v_kpi_history AS
 SELECT k.* FROM mart.kpi_result k JOIN mart.v_latest_refresh r USING(run_id);

CREATE OR REPLACE VIEW mart.v_rolling_5_days AS
 WITH selected AS (
   SELECT d.run_id,d.work_date,d.period_key
   FROM mart.calendar_day d JOIN mart.v_latest_refresh r USING(run_id)
   WHERE d.scheduled AND d.work_date<=r.as_of_date
   ORDER BY d.work_date DESC LIMIT 5
 )
 SELECT d.work_date,d.period_key,
   s.line_code,s.planned_units,s.scenario_good_units,s.mes_produced_units,
   s.qc_sample_count,s.qc_passed_count,
   p.metric_value AS scenario_attainment_percent,
   q.metric_value AS qc_sample_pass_percent,
   e.metric_value AS synthetic_ehs_rate_per_100k_hours,
   m.metric_value AS downtime_minutes,
   'SYNTHETIC SCENARIO; MES PRODUCED IS DISTINCT'::text AS disclosure
 FROM selected d
 LEFT JOIN mart.source_shift s ON s.run_id=d.run_id AND s.work_date=d.work_date
 LEFT JOIN mart.kpi_result p ON p.run_id=d.run_id AND p.grain='day'
     AND p.period_key=to_char(d.work_date,'YYYY-MM-DD') AND p.metric_id='SCENARIO_ATTAINMENT'
 LEFT JOIN mart.kpi_result q ON q.run_id=d.run_id AND q.grain='day'
     AND q.period_key=to_char(d.work_date,'YYYY-MM-DD') AND q.metric_id='QC_SAMPLE_PASS'
 LEFT JOIN mart.kpi_result e ON e.run_id=d.run_id AND e.grain='day'
     AND e.period_key=to_char(d.work_date,'YYYY-MM-DD') AND e.metric_id='SYNTHETIC_EVENT_RATE'
 LEFT JOIN mart.kpi_result m ON m.run_id=d.run_id AND m.grain='day'
     AND m.period_key=to_char(d.work_date,'YYYY-MM-DD') AND m.metric_id='DOWNTIME_MINUTES'
 ORDER BY d.work_date;

CREATE OR REPLACE VIEW mart.v_rolling_12_months AS
 WITH months AS (
   SELECT r.run_id,to_char(g.month_start,'YYYY-MM') AS period_key
   FROM mart.v_latest_refresh r
   CROSS JOIN LATERAL generate_series(
     (date_trunc('month',r.as_of_date)::date-interval '12 months')::date,
     (date_trunc('month',r.as_of_date)::date-interval '1 month')::date,
     interval '1 month') AS g(month_start)
 )
 SELECT m.period_key, k.department,k.metric_id,k.numerator,k.denominator,
        k.metric_value,k.unit,k.status,k.formula_version,k.interpretation_note
 FROM months m
 LEFT JOIN mart.kpi_result k ON k.run_id=m.run_id AND k.grain='month'
   AND k.period_key=m.period_key
 ORDER BY m.period_key,k.department,k.metric_id;

CREATE OR REPLACE VIEW mart.v_current_month AS
 SELECT k.* FROM mart.kpi_result k JOIN mart.v_latest_refresh r USING(run_id)
 WHERE k.grain='month' AND k.period_key=to_char(r.as_of_date,'YYYY-MM');

CREATE OR REPLACE VIEW mart.v_targets AS
 SELECT t.* FROM mart.kpi_target t JOIN mart.v_latest_refresh r USING(run_id);

CREATE OR REPLACE VIEW mart.v_calendar AS
 SELECT c.* FROM mart.calendar_day c JOIN mart.v_latest_refresh r USING(run_id);


-- Explicit reporting-only source projections: no raw vendor DB credentials in Excel.
CREATE OR REPLACE VIEW mart.v_source_exposure AS
 SELECT e.* FROM mart.source_exposure e JOIN mart.v_latest_refresh r USING(run_id);
CREATE OR REPLACE VIEW mart.v_source_ehs AS
 SELECT e.* FROM mart.source_ehs_event e JOIN mart.v_latest_refresh r USING(run_id);
CREATE OR REPLACE VIEW mart.v_source_maintenance AS
 SELECT e.* FROM mart.source_maintenance e JOIN mart.v_latest_refresh r USING(run_id);
CREATE OR REPLACE VIEW mart.v_source_downtime AS
 SELECT e.* FROM mart.source_downtime e JOIN mart.v_latest_refresh r USING(run_id);
CREATE OR REPLACE VIEW mart.v_kpi_definitions AS
 SELECT * FROM mart.kpi_definition ORDER BY department,metric_id;

COMMIT;

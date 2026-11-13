param(
  [Parameter(Mandatory=$true)][string]$ReportJson,
  [Parameter(Mandatory=$true)][string]$InvestigationJson,
  [Parameter(Mandatory=$true)][string]$OutputXlsx
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $ReportJson -PathType Leaf) -or
    -not (Test-Path -LiteralPath $InvestigationJson -PathType Leaf)) {
  throw "FDE report input not found"
}
if (Test-Path -LiteralPath $OutputXlsx) { throw "Refusing to overwrite an existing workbook" }
$folder=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputXlsx))
if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
  throw "Output directory does not exist"
}
$report=Get-Content -LiteralPath $ReportJson -Raw -Encoding UTF8 | ConvertFrom-Json
$draft=Get-Content -LiteralPath $InvestigationJson -Raw -Encoding UTF8 | ConvertFrom-Json
if ($report.schema -ne "fde.performance-report/v1" -or
    $draft.schema -ne "fde.investigation-draft/v1" -or
    $report.sourceWriteAllowed -ne $false -or
    $draft.authority -ne "review-only" -or
    @($report.periods).Count -lt 1) {
  throw "FDE report or review draft contract refused"
}
$excel=$null
$book=$null
function Put($sheet,[int]$row,[int]$col,$value) {
  $cell=$sheet.Range(([string][char](64+$col))+[string]$row)
  if ($null -eq $value) { $value="Unknown" }
  if ($value -is [string]) {
    $value=$value.Trim()
    if ($value.StartsWith("=") -or $value.StartsWith("+") -or
        $value.StartsWith("-") -or $value.StartsWith("@")) {
      $value="'"+$value
    }
    $cell.NumberFormat="@"
  }
  $cell.Value2=[string]$value
}
function PutNumber($sheet,[int]$row,[int]$col,[double]$value) {
  $cell=$sheet.Range(([string][char](64+$col))+[string]$row)
  $cell.NumberFormat="General"
  $cell.Value2=[double]$value
}
function Head($sheet,[int]$row,[string[]]$columns) {
  for ($i=0;$i -lt $columns.Length;$i++) { Put $sheet $row ($i+1) $columns[$i] }
  $end=$columns.Length
  $range=$sheet.Range("A"+$row+":"+([string][char](64+$end))+$row)
  $range.Interior.Color=3618615
  $range.Font.Color=16777215
  $range.Font.Bold=$true
  $range.RowHeight=23
}
function NewTab($name) {
  $sheet=$book.Worksheets.Add()
  $sheet.Name=$name
  $sheet.Cells.Font.Name="Aptos"
  $sheet.Cells.Font.Size=10
  $sheet.Columns.Item(1).ColumnWidth=27
  return $sheet
}
function Banner($sheet,$title,$subtitle) {
  $sheet.Range("A1:H1").Merge()
  Put $sheet 1 1 $title
  $sheet.Range("A1:H1").Font.Bold=$true
  $sheet.Range("A1:H1").Font.Size=18
  $sheet.Range("A1:H1").RowHeight=32
  $sheet.Range("A2:H2").Merge()
  Put $sheet 2 1 $subtitle
  $sheet.Range("A2:H2").Font.Color=8421504
}
try {
  $excel=New-Object -ComObject Excel.Application
  $excel.DisplayAlerts=$false
  $excel.AskToUpdateLinks=$false
  $excel.Visible=$false
  $book=$excel.Workbooks.Add()
  while ($book.Worksheets.Count -gt 1) { $book.Worksheets.Item(2).Delete() }
  $performance=$book.Worksheets.Item(1)
  $performance.Name="Performance"
  $performance.Cells.Font.Name="Aptos"
  $performance.Cells.Font.Size=10
  Banner $performance "Manufacturing Performance | Shift Review" "Engineer-prepared reporting view • manual or synthetic inputs • not a validated plant record"
  $latest=@($report.periods)[@($report.periods).Count-1]
  Put $performance 4 1 "Reporting periods"
  PutNumber $performance 4 2 @($report.periods).Count
  Put $performance 4 3 "Latest attainment"
  PutNumber $performance 4 4 ([double]::Parse([string]$latest.attainmentPercent,[Globalization.CultureInfo]::InvariantCulture))
  Put $performance 4 5 "Latest gap (units)"
  PutNumber $performance 4 6 ([double]$latest.shortfallUnits)
  Put $performance 4 7 "Loss allocation"
  Put $performance 4 8 $latest.lossStatus
  $performance.Range("A4:H4").Font.Bold=$true
  Head $performance 7 @("Period","Line","Planned","Good","Shortfall","Attainment %","Loss status","Unclassified")
  $ri=8
  foreach ($period in @($report.periods)) {
    Put $performance $ri 1 $period.periodId
    Put $performance $ri 2 $period.lineId
    PutNumber $performance $ri 3 ([double]$period.plannedUnits)
    PutNumber $performance $ri 4 ([double]$period.goodUnits)
    PutNumber $performance $ri 5 ([double]$period.shortfallUnits)
    if ($null -eq $period.attainmentPercent) {
      Put $performance $ri 6 "Unknown"
    } else {
      PutNumber $performance $ri 6 ([double]::Parse([string]$period.attainmentPercent,[Globalization.CultureInfo]::InvariantCulture))
    }
    Put $performance $ri 7 $period.lossStatus
    PutNumber $performance $ri 8 ([double]$period.unclassifiedUnits)
    $ri++
  }
  $performance.Range("C8:F"+($ri-1)).NumberFormat="0.00"
  $performance.Range("H8:H"+($ri-1)).NumberFormat="0"
  $performance.Range("A7:H"+($ri-1)).AutoFilter() | Out-Null
  $performance.Columns.Item(1).ColumnWidth=25
  $performance.Columns.Item(2).ColumnWidth=16
  $performance.Columns.Item(7).ColumnWidth=30
  $performance.Columns.Item(8).ColumnWidth=17
  $performance.Range("A6:H6").Merge()
  Put $performance 6 1 "Values are calculated by FDE's compiled Haskell. Percentages are attainment, not OEE."
  if ($ri -gt 9) {
    $co=$performance.ChartObjects().Add(550,210,660,310)
    $chart=$co.Chart
    $chart.ChartType=4 # xlLine
    $series=$chart.SeriesCollection().NewSeries()
    $series.Name="Attainment (%)"
    $series.XValues=$performance.Range("A8:A"+($ri-1))
    $series.Values=$performance.Range("F8:F"+($ri-1))
    $chart.HasTitle=$true
    $chart.ChartTitle.Text="Production attainment trend"
  }
  $pareto=NewTab "Loss Pareto"
  Banner $pareto "Loss Pareto | Latest Report" ("Period: "+$latest.periodId+" • descriptive loss categories, not confirmed causes")
  Head $pareto 7 @("Loss category","Units","Share %","Cumulative %")
  $r=8
  foreach ($loss in @($latest.pareto)) {
    Put $pareto $r 1 $loss.id
    PutNumber $pareto $r 2 ([double]$loss.units)
    if ($null -eq $loss.sharePercent) {Put $pareto $r 3 "Unknown"} else {
      PutNumber $pareto $r 3 ([double]::Parse([string]$loss.sharePercent,[Globalization.CultureInfo]::InvariantCulture))}
    if ($null -eq $loss.cumulativePercent) {Put $pareto $r 4 "Unknown"} else {
      PutNumber $pareto $r 4 ([double]::Parse([string]$loss.cumulativePercent,[Globalization.CultureInfo]::InvariantCulture))}
    $r++
  }
  $pareto.Columns.Item(1).ColumnWidth=33
  $pareto.Columns.Item(2).ColumnWidth=19
  $pareto.Columns.Item(3).ColumnWidth=20
  $pareto.Columns.Item(4).ColumnWidth=22
  if ($r -gt 8) {
    $co=$pareto.ChartObjects().Add(500,180,650,330)
    $chart=$co.Chart
    $chart.ChartType=51 # xlColumnClustered
    $series=$chart.SeriesCollection().NewSeries()
    $series.Name="Lost units"
    $series.XValues=$pareto.Range("A8:A"+($r-1))
    $series.Values=$pareto.Range("B8:B"+($r-1))
    $chart.HasTitle=$true
    $chart.ChartTitle.Text="Categorized lost units (not causality)"
  }
  $investigations=NewTab "Investigation"
  Banner $investigations "Investigation Workspace" "Human engineer records hypotheses, checks, trial plans and outcomes."
  Put $investigations 4 1 "Suggested focus"
  Put $investigations 4 2 $draft.focusPeriod
  Put $investigations 5 1 "Draft origin"
  Put $investigations 5 2 $draft.origin
  Put $investigations 5 3 "No automatic approval or process action"
  Head $investigations 7 @("Suggested check","Owner","Status","Engineering notes","Date reviewed")
  $labels=@{
    "review-loss-categorization"="Verify loss categorization and mutual exclusivity";
    "verify-shift-boundary"="Check shift boundaries, time and reporting grain";
    "inspect-highest-loss-category"="Inspect the leading loss category at the source process";
    "compare-plan-revision"="Confirm plan revision and reporting baseline";
    "review-measurement-method"="Validate measurement and sampling method";
    "prepare-countermeasure-trial"="Prepare a controlled improvement trial and acceptance measures"
  }
  $r=8
  foreach ($id in @($draft.questionIds)) {
    if (-not $labels.ContainsKey([string]$id)) {throw "Unexpected draft question id"}
    Put $investigations $r 1 $labels[[string]$id]
    Put $investigations $r 2 ""
    Put $investigations $r 3 "To review"
    $r++
  }
  $investigations.Columns.Item(1).ColumnWidth=60
  $investigations.Columns.Item(2).ColumnWidth=20
  $investigations.Columns.Item(3).ColumnWidth=17
  $investigations.Columns.Item(4).ColumnWidth=60
  $investigations.Columns.Item(5).ColumnWidth=19
  Put $investigations ($r+2) 1 "Draft rationale (not a finding)"
  Put $investigations ($r+3) 1 $draft.rationale
  $investigations.Range("A"+($r+3)+":E"+($r+3)).Merge()
  $investigations.Range("A"+($r+3)).WrapText=$true
  $investigations.Rows.Item($r+3).RowHeight=38
  $inputs=NewTab "Source Inputs"
  Banner $inputs "Source Inputs | Reproducible Export" "Manual/synthetic normalized data. This Excel workbook never reads or updates ERP/MES."
  Head $inputs 7 @("Period","Line","Planned","Good","Source class","Loss allocation")
  $r=8
  foreach ($period in @($report.periods)) {
    Put $inputs $r 1 $period.periodId
    Put $inputs $r 2 $period.lineId
    PutNumber $inputs $r 3 ([double]$period.plannedUnits)
    PutNumber $inputs $r 4 ([double]$period.goodUnits)
    Put $inputs $r 5 $report.sourceClass
    Put $inputs $r 6 $period.lossStatus
    $r++
  }
  $inputs.Columns.Item(1).ColumnWidth=28
  $inputs.Columns.Item(5).ColumnWidth=24
  $inputs.Columns.Item(6).ColumnWidth=29
  $book.SaveAs([IO.Path]::GetFullPath($OutputXlsx),51)
  Write-Output ("EXCEL_FILE="+[IO.Path]::GetFullPath($OutputXlsx))
  Write-Output ("PERIOD_COUNT="+@($report.periods).Count)
  Write-Output ("SHEETS=Performance,Loss Pareto,Investigation,Source Inputs")
  Write-Output ("AZURE_DRAFT_ORIGIN="+$draft.origin)
} finally {
  if ($book -ne $null) {$book.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)}
  if ($excel -ne $null) {$excel.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)}
}

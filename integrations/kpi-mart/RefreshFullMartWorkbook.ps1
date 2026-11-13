param(
 [Parameter(Mandatory=$true)][string]$SourceFolder,
 [Parameter(Mandatory=$true)][string]$Destination,
 [string]$Previous=""
)
# New 16-sheet workbook; never modifies the accepted source or previous workbook.
$ErrorActionPreference="Stop"
$dir=[IO.Path]::GetFullPath($SourceFolder)
$out=[IO.Path]::GetFullPath($Destination)
if(!(Test-Path -LiteralPath $dir -PathType Container) -or (Test-Path -LiteralPath $out) -or
   [IO.Path]::GetExtension($out) -ne ".xlsx"){throw "Unsafe source or output"}
$manifest=Get-Content -LiteralPath (Join-Path $dir "manifest.json") -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.schema -ne "fde.kpi-mart-excel-snapshot/v1" -or
   $manifest.state -ne "accepted-read-only-local-export" -or
   $manifest.source_run_id -ne "fde-mart-20261113-v1" -or
   $manifest.as_of_date -ne "2026-11-12" -or
   $manifest.cloud_model_calls -ne 0 -or $manifest.vendor_mutations -ne 0){
  throw "Source receipt refused"
}
$data=@{}
foreach($item in $manifest.files.PSObject.Properties){
 $filename=$item.Name
 if($filename -notmatch '^[a-z0-9_]+\.csv$'){throw "Unknown snapshot file"}
 $path=Join-Path $dir $filename
 if(!(Test-Path -LiteralPath $path -PathType Leaf) -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne [string]$item.Value.sha256){
   throw "Snapshot SHA mismatch"
 }
 $rows=@(Import-Csv -LiteralPath $path -Encoding UTF8)
 if($rows.Count -ne [int]$item.Value.rows){throw "Snapshot row count mismatch"}
 $data[$filename]=$rows
}
$expected=@{"source_shifts.csv"=314;"source_exposure.csv"=314;"source_ehs.csv"=29;
 "source_maintenance.csv"=149;"source_downtime.csv"=29;"calendar.csv"=438;
 "targets.csv"=60;"kpi_history.csv"=2961;"rolling_5_days.csv"=5;
 "rolling_12_months.csv"=108;"current_month.csv"=9;"definitions.csv"=9}
foreach($key in $expected.Keys){
 if(!$data.ContainsKey($key) -or $data[$key].Count -ne $expected[$key]){throw "Invalid source schema/cardinality: $key"}
}
if([int](($data["source_shifts.csv"]|Measure-Object -Property planned_units -Sum).Sum) -ne 5754 -or
   [int](($data["source_shifts.csv"]|Measure-Object -Property mes_produced_units -Sum).Sum) -ne 0){throw "Scenario/MES mismatch"}
$months=@{};$daily=@{}
foreach($r in $data["kpi_history.csv"]){
 if($r.grain -eq "month"){
  if(!$months.ContainsKey($r.period_key)){$months[$r.period_key]=@{}}
  $months[$r.period_key][$r.metric_id]=$r
 }elseif($r.grain -eq "day"){
  if(!$daily.ContainsKey($r.period_key)){$daily[$r.period_key]=@{}}
  $daily[$r.period_key][$r.metric_id]=$r
 }else{throw "Bad period grain"}
}
if($months.Keys.Count -ne 15 -or $daily.Keys.Count -ne 314){throw "Bad reporting horizon"}
$keys=@($months.Keys|Sort-Object -Descending)
$closed=@($keys|Where-Object{$_ -lt "2026-11"}|Select-Object -First 12)
$five=@($data["rolling_5_days.csv"]|Sort-Object work_date -Descending)
if($closed.Count -ne 12 -or $five[0].work_date -ne "2026-11-12" -or
 $five[4].work_date -ne "2026-11-06"){throw "Wrong five-day or twelve-month window"}
function N($x){
 if($null -eq $x -or [string]$x -eq ""){return $null}
 return [double]::Parse([string]$x,[Globalization.CultureInfo]::InvariantCulture)
}
function P($x){$v=N $x;if($null -eq $v){return $null};return $v/100.0}
function Dt($x){
 if(!$x){return $null}
 return ([datetime]::ParseExact([string]$x,"yyyy-MM-dd",[Globalization.CultureInfo]::InvariantCulture)).ToOADate()
}
function M([string]$period,[string]$id,[string]$field="metric_value"){
 if(!$months.ContainsKey($period) -or !$months[$period].ContainsKey($id)){return $null}
 return $months[$period][$id].($field)
}
function Day([string]$period,[string]$id,[string]$field="metric_value"){
 if(!$daily.ContainsKey($period) -or !$daily[$period].ContainsKey($id)){return $null}
 return $daily[$period][$id].($field)
}
function Safe($v){
 if($null -eq $v){return ""}
 if($v -is [string] -and $v -match '^[\s]*[=+\-@]'){return "'"+$v}
 return $v
}
$excel=$null;$book=$null;$old=$null
$names=@("Read Me","Template & Rules","Rolling 5 Days","Rolling 12 Months",
 "Current Month","Production","Quality","Safety","Maintenance","Action Tracker",
 "Raw Shifts","Raw EHS","Raw PM","Raw Downtime","Calendar","Targets")
function Banner($sheet,$title,$caption){
 $sheet.Range("A1:L1").Merge();$sheet.Range("A2:L2").Merge()
 $sheet.Range("A1").Value2=[string]$title;$sheet.Range("A2").Value2=[string]$caption
 $sheet.Range("A1:L1").Interior.Color=4144964
 $sheet.Range("A1:L1").Font.Color=16777215
 $sheet.Range("A1:L1").Font.Bold=$true;$sheet.Range("A1:L1").Font.Size=16
 $sheet.Range("A1:L1").RowHeight=36
}
function Block($sheet,[string[]]$headers,[object[]]$rows,[int]$row){
 $w=$headers.Count;$h=$rows.Count+1
 if($w -lt 1 -or $w -gt 16){throw "Grid width"}
 $v=[Array]::CreateInstance([object],@([int]$h,[int]$w))
 for($j=0;$j -lt $w;$j++){$v[0,$j]=$headers[$j]}
 for($i=0;$i -lt $rows.Count;$i++){
  $line=@($rows[$i]);if($line.Count -ne $w){throw "Grid shape"}
  for($j=0;$j -lt $w;$j++){$v[($i+1),$j]=Safe $line[$j]}
 }
 for($i=0;$i -lt $h;$i++){
    for($j=0;$j -lt $w;$j++){
      $cell=$sheet.Cells.Item(($row+$i),($j+1))
      $item=$v[$i,$j]
      if($null -eq $item){$cell.Value2=""}
      elseif($item -is [double] -or $item -is [int] -or $item -is [long]){
        $cell.Value2=[double]$item
      }else{$cell.Value2=[string]$item}
    }
  }
 $head=$sheet.Cells.Item($row,1).Resize(1,$w)
 $head.Font.Bold=$true;$head.Font.Color=16777215;$head.Interior.Color=5256253;$head.RowHeight=24
}
try{
 $excel=New-Object -ComObject Excel.Application
 $excel.Visible=$false;$excel.DisplayAlerts=$false;$excel.EnableEvents=$false
 $excel.AutomationSecurity=3
 $book=$excel.Workbooks.Add()
 while($book.Worksheets.Count -gt 1){$book.Worksheets.Item(2).Delete()}
 $book.Worksheets.Item(1).Name="Targets"
 for($i=$names.Count-2;$i -ge 0;$i--){$book.Worksheets.Add().Name=$names[$i]}
 $sheets=@{};foreach($name in $names){
  $sheets[$name]=$book.Worksheets.Item($name)
  $sheets[$name].Cells.Font.Name="Aptos";$sheets[$name].Cells.Font.Size=10
  $sheets[$name].Columns("A:L").ColumnWidth=18
 }
 $s=$sheets["Read Me"];Banner $s "FDE | Manufacturing KPI Workbench" "PostgreSQL KPI mart snapshot • local synthetic ERPNext/OpenMES • human-led investigations"
 Block $s @("Control","Interpretation") @(
  @("Mart run",$manifest.source_run_id),
  @("As of",$manifest.as_of_date),
  @("Source digest",$manifest.source_sha256),
  @("Kernel digest",$manifest.kernel_sha256),
  @("Source rows","314 shifts, 149 maintenance, 29 downtime, 29 synthetic EHS"),
  @("KPI rows","2,961 persisted daily/monthly results"),
  @("MES output","0 native reported units; pending production"),
  @("Scenario output","Fictional modelled good units, NOT native MES output"),
  @("Quality","QC SAMPLE PASS, NOT production FPY"),
  @("Safety","Synthetic EHS per 100k hours; NOT OSHA TRIR"),
  @("Calendar","Provisional weekday/closed calendar-month periods"),
  @("Targets","Demo only; not business-approved"),
  @("Data access","Verified snapshot, not a live workbook database connection"),
  @("Refresh","LangGraph creates a new output; human action history separate")
 ) 5
 $s.Columns("A:A").ColumnWidth=25;$s.Columns("B:B").ColumnWidth=91
 $s=$sheets["Template & Rules"];Banner $s "Template & Rules" "Calculation owners, formula versions, numerators, denominators and calendar state"
 $s.Range("A3").Value2="As of";$s.Range("B3").Value2=(Dt $manifest.as_of_date)
 $s.Range("B3").NumberFormat="yyyy-mm-dd"
 $s.Range("A4").Value2="Period";$s.Range("B4").Value2="PROVISIONAL calendar months"
 $s.Range("A5").Value2="Holidays";$s.Range("B5").Value2="UNCONFIGURED"
 $s.Range("A6").Value2="Mart run";$s.Range("B6").Value2=[string]$manifest.source_run_id
 $rows=@();foreach($r in $data["definitions.csv"]){
  $rows+=,@($r.metric_id,$r.department,$r.display_name,$r.numerator_description,
           $r.denominator_description,$r.formula_version,$r.calculation_owner,$r.interpretation_note)
 }
 Block $s @("Metric","Dept","Description","Numerator","Denominator","Version","Owner","Limitation") $rows 9
 $s.Columns("A:G").ColumnWidth=28;$s.Columns("H:H").ColumnWidth=55
 $s=$sheets["Rolling 5 Days"];Banner $s "Rolling Five Scheduled Days" "Persisted as-of Nov 12, 2026; sorted latest first"
 $rows=@();foreach($x in $five){
  $d=$x.work_date
  $rows+=,@((Dt $d),(N $x.planned_units),(N $x.scenario_good_units),
   (P $x.scenario_attainment_percent),(N $x.mes_produced_units),
   (P $x.qc_sample_pass_percent),(N $x.qc_sample_count),
   (N (Day $d "SYNTHETIC_EVENT_COUNT")),(N (Day $d "SYNTHETIC_EVENT_RATE" "denominator")),
   (N $x.downtime_minutes),(N (Day $d "PM_DUE_COUNT")),(P (Day $d "PM_ON_TIME")))
 }
 Block $s @("Date","Plan","Scenario Good","Attain","MES Output","QC Pass","Samples",
            "EHS Events","Hours","Downtime","PM Due","PM Pass") $rows 7
 $s.Range("A8:A12").NumberFormat="yyyy-mm-dd"
 foreach($c in @("D","F","L")){$s.Range($c+"8:"+$c+"12").NumberFormat="0.0%"}
 $s=$sheets["Rolling 12 Months"];Banner $s "Rolling Twelve Closed Months" "Closed months exclude current MTD; rates come from stored numerator/denominator"
 $rows=@();foreach($p in $closed){
  $rows+=,@($p,(N (M $p "SCENARIO_ATTAINMENT" "denominator")),
   (N (M $p "SCENARIO_ATTAINMENT" "numerator")),(P (M $p "SCENARIO_ATTAINMENT")),
   (N (M $p "NATIVE_MES_OUTPUT_UNITS")),(P (M $p "QC_SAMPLE_PASS")),
   (N (M $p "QC_SAMPLE_PASS" "denominator")),(N (M $p "SYNTHETIC_EVENT_COUNT")),
   (N (M $p "SYNTHETIC_EVENT_RATE" "denominator")),(N (M $p "DOWNTIME_MINUTES")),
   (N (M $p "PM_DUE_COUNT")),(P (M $p "PM_ON_TIME")))
 }
 Block $s @("Month","Plan","Scenario Good","Attain","MES Output","QC Pass",
           "Samples","EHS Events","Hours","Downtime","PM Due","PM Pass") $rows 7
 foreach($c in @("D","F","L")){$s.Range($c+"8:"+$c+"19").NumberFormat="0.0%"}
 $chart=$s.ChartObjects().Add(500,210,500,270)
 $chart.Chart.ChartType=4
 $ser=$chart.Chart.SeriesCollection().NewSeries()
 $ser.Name="Scenario attainment";$ser.XValues=$s.Range("A8:A19");$ser.Values=$s.Range("D8:D19")
 $chart.Chart.HasTitle=$true;$chart.Chart.ChartTitle.Text="12-month synthetic scenario attainment"
 $s=$sheets["Current Month"];Banner $s "Current Month" "Four departments • synthetic rates • approved as-of date Nov 12, 2026"
 $s.Range("A4").Value2="Month";$s.Range("B4").Value2="2026-11"
 Block $s @("Department","KPI","Actual","Demo Target","Interpretation","Review") @(
  @("Production","Scenario attainment",(P (M "2026-11" "SCENARIO_ATTAINMENT")),0.90,"Not native MES output","Review"),
  @("Quality","QC sample pass",(P (M "2026-11" "QC_SAMPLE_PASS")),0.91,"NOT FPY","Review"),
  @("Safety","Synthetic events/100k hrs",(N (M "2026-11" "SYNTHETIC_EVENT_RATE")),0,"NOT OSHA TRIR","Review"),
  @("Maintenance","PM on time",(P (M "2026-11" "PM_ON_TIME")),0.85,"Nothing due yet","N/A / NOT DUE")
 ) 7
 $s.Range("C8:D9").NumberFormat="0.0%";$s.Range("C11:D11").NumberFormat="0.0%"
 $s.Columns("E:F").ColumnWidth=30
 foreach($dept in @("Production","Quality","Safety","Maintenance")){
  $s=$sheets[$dept];Banner $s ($dept+" | Investigation") "Monthly persisted KPI history; engineer controls review and actions"
  $rows=@();$h=@()
  foreach($p in $keys){
   switch($dept){
    "Production" {$h=@("Month","Plan","Scenario Good","Attain","MES Output","Meaning");$rows+=,@($p,(N (M $p "SCENARIO_ATTAINMENT" "denominator")),(N (M $p "SCENARIO_ATTAINMENT" "numerator")),(P (M $p "SCENARIO_ATTAINMENT")),(N (M $p "NATIVE_MES_OUTPUT_UNITS")),"MODELLED")}
    "Quality" {$h=@("Month","QC Checks","Samples","Passed","Pass Rate","Meaning");$rows+=,@($p,(N (M $p "QC_CHECK_COUNT")),(N (M $p "QC_SAMPLE_PASS" "denominator")),(N (M $p "QC_SAMPLE_PASS" "numerator")),(P (M $p "QC_SAMPLE_PASS")),"NOT FPY")}
    "Safety" {$h=@("Month","Exposure Hrs","Events","Events/100k","Meaning");$rows+=,@($p,(N (M $p "SYNTHETIC_EVENT_RATE" "denominator")),(N (M $p "SYNTHETIC_EVENT_COUNT")),(N (M $p "SYNTHETIC_EVENT_RATE")),"NOT OSHA")}
    "Maintenance" {$h=@("Month","PM Due","PM On Time","Compliance","Down Minutes","Meaning");$rows+=,@($p,(N (M $p "PM_DUE_COUNT")),(N (M $p "PM_ON_TIME" "numerator")),(P (M $p "PM_ON_TIME")),(N (M $p "DOWNTIME_MINUTES")),"SYNTHETIC")}
   }
  }
  Block $s $h $rows 7
  if($dept -eq "Quality"){$s.Range("E8:E22").NumberFormat="0.0%"}
  if($dept -eq "Maintenance" -or $dept -eq "Production"){$s.Range("D8:D22").NumberFormat="0.0%"}
 }
 $s=$sheets["Action Tracker"];Banner $s "Engineer Action Tracker" "Preserves manually entered actions when PreviousWorkbook is supplied"
 $rows=@(
  @("Production","2026-11","Modelled vs MES output","", "To Review","","",""),
  @("Quality","2026-11","Sampling method","","To Review","","",""),
  @("Safety","2026-11","Exposure coverage","","To Review","","",""),
  @("Maintenance","2026-11","Maintenance issues","","To Review","","","")
 )
 if($Previous){
  $old=$excel.Workbooks.Open([IO.Path]::GetFullPath($Previous),0,$true)
  $sh=$old.Worksheets.Item("Action Tracker");$rows=@()
  for($i=7;$i -le 80;$i++){
   $record=@();for($j=1;$j -le 8;$j++){$record+=(Safe $sh.Cells.Item($i,$j).Text)}
   if([string]$record[0]){$rows+=,$record}
  }
  $old.Close($false)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($old)
  $old=$null
 }
 Block $s @("Dept","Month","Question","Owner","Status","Due","Hypothesis","Evidence") $rows 6
 $s.Columns("C:C").ColumnWidth=43;$s.Columns("G:H").ColumnWidth=30
 $raw=@(
 @("Raw Shifts","source_shifts.csv",@("work_date","period_key","line_code","erp_work_order","mes_work_order","planned_units","scenario_good_units","scenario_reject_units","scenario_unfinished_units","mes_produced_units","qc_sample_count","qc_passed_count","data_class")),
 @("Raw PM","source_maintenance.csv",@("scheduled_date","completed_date","event_type","source_status","workstation_code","source_title")),
 @("Raw Downtime","source_downtime.csv",@("work_date","duration_minutes","reason_id","source_notes")),
 @("Calendar","calendar.csv",@("work_date","period_key","scheduled","holiday_state","fiscal_year","fiscal_period","calendar_version")),
 @("Targets","targets.csv",@("period_key","department","metric_id","target_value","status"))
 )
 foreach($item in $raw){
  $sh=$sheets[$item[0]];Banner $sh $item[0] "Accepted KPI mart source projection • synthetic values disclosed"
  $cols=@($item[2]);$rows=@()
  foreach($r in $data[$item[1]]){
   $line=@()
   foreach($col in $cols){
    $v=$r.$col
    if($col -in @("work_date","scheduled_date","completed_date")){$v=Dt $v}
    elseif($col -match 'units|count|qty|minutes|fiscal_|target_value'){$v=N $v}
    $line+=,$v
   }
   $rows+=,$line
  }
  Block $sh $cols $rows 5
  $sh.Columns("A:A").ColumnWidth=22
  if($item[0] -eq "Raw Shifts"){$sh.Columns("D:E").ColumnWidth=33}
 }
 $sh=$sheets["Raw EHS"];Banner $sh "Raw EHS" "Exposure and incident populations remain synthetic; not OSHA-reportable"
 $event=@{};foreach($e in $data["source_ehs.csv"]){$event[$e.occurred_date]=$e}
 $rows=@();foreach($r in $data["source_exposure.csv"]){
  $e=$event[$r.work_date]
  $rows+=,@((Dt $r.work_date),$r.period_key,(N $r.exposure_hours),
   $(if($e){1}else{0}),$(if($e){$e.event_kind}else{""}),
   $(if($e){$e.action_status}else{""}))
 }
 Block $sh @("Date","Month","Exposure Hrs","Events","Kind","Action") $rows 5
 $book.SaveAs($out,51)
 Write-Output "FDE_FULL_16_SHEET_CREATED=$out"
 Write-Output "SHEETS=$($book.Worksheets.Count)"
 Write-Output "SOURCE=$($manifest.source_run_id)"
 Write-Output "NO_AZURE_CALLS=1"
}finally{
 if($old){$old.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($old)}
 if($book){$book.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)}
 if($excel){$excel.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)}
}

/** FDE Excel 16-sheet template: calculation-only Office Script.
 * Office Scripts execution is NOT qualified for this personal account.
 * The native data extraction/Excel table update runs separately in LangGraph.
 */
function main(workbook: ExcelScript.Workbook, asOfDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error("ISO date required");
  const parsed = new Date(asOfDate + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10)!==asOfDate)
    throw new Error("Invalid date");
  for (const name of ["Read Me","Template & Rules","Rolling 5 Days","Rolling 12 Months",
      "Current Month","Production","Quality","Safety","Maintenance","Action Tracker",
      "Raw Shifts","Raw EHS","Raw PM","Raw Downtime","Calendar","Targets"]) {
    if (!workbook.getWorksheet(name)) throw new Error("Missing source view "+name);
  }
  const shifts=workbook.getTable("ShiftResults");
  if (!shifts || shifts.getRowCount()===0) throw new Error("Missing native shift rows");
  const excelDay=Date.UTC(parsed.getUTCFullYear(),parsed.getUTCMonth(),parsed.getUTCDate())/86400000+25569;
  const control=workbook.getWorksheet("Template & Rules").getRange("B3");
  control.setNumberFormat("yyyy-mm-dd");
  control.setValue(excelDay);
  workbook.getApplication().calculate(ExcelScript.CalculationType.fullRebuild);
  for (const ws of workbook.getWorksheets()) {
    const used=ws.getUsedRange();
    if (used && used.getValueTypes().some(row => row.includes(ExcelScript.RangeValueType.error)))
       throw new Error("Formula error in "+ws.getName());
  }
  return JSON.stringify({status:"recalculated",asOfDate,sourceRows:shifts.getRowCount(),
                         vendorWrites:0,AzureModelCalls:0});
}

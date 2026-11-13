{-# LANGUAGE OverloadedStrings #-}
-- Finite industrial investigation meaning. Pure; no IO, clock, authorization,
-- source acquisition, workflow persistence, or operational effect authority.
module FDE.Industrial
  ( Investigation(..), TriageInput(..), PdmInput(..), ProcessInput(..)
  , Observation(..), MechanicalInput(..), WorkerInput(..), MoneyItem(..)
  , Assessment(..), Finding(..), FindingStatus(..), Metric(..), assess
  , CatalogEntry(..), industrialCatalog
  , InventoryEvidence(..), assessCase
  , BomInput(..), BomLine(..), Substitution(..), WhereUsed(..)
  ) where
import Data.List (nub,find,sort,foldl')
import Data.Ratio ((%))
import Data.Text (Text)
import qualified Data.Text as T
import FDE.Kernel (canonicalQuantity)

data Investigation = Triage TriageInput | Pdm PdmInput | Process ProcessInput
  | Mechanical MechanicalInput | WorkerBenefit WorkerInput | Bom BomInput deriving (Eq,Show)
data TriageInput = TriageInput
  { concern :: Text, availableEvidence :: [Text], measurementReady :: Bool
  , workerConcern :: Bool } deriving (Eq,Show)
data PdmInput = PdmInput
  { partId :: Text, configuration :: Text
  , requiredRevision :: Maybe Text, observedRevision :: Maybe Text
  , identity :: Text, release :: Text, effectivity :: Text
  , approvedAlternate :: Bool, changeApproved :: Bool, changePropagated :: Maybe Bool
  , engineeringQuantity :: Maybe Text, manufacturingQuantity :: Maybe Text
  , engineeringUnit :: Maybe Text, manufacturingUnit :: Maybe Text
  , pdmEvidence :: [Text] } deriving (Eq,Show)
data Observation = Observation
  { samples :: [Text], observationUnit :: Text, population :: Text
  , method :: Text, basis :: Text, conditions :: Text, observationWindow :: Text
  , measurementQuality :: Text } deriving (Eq,Show)
data ProcessInput = ProcessInput
  { measure :: Text, baseline :: Observation, followup :: Observation
  , processEvidence :: [Text] } deriving (Eq,Show)
data MechanicalInput = MechanicalInput
  { mechanicalMode :: Text, requirements :: [Text], designs :: [Text]
  , measurements :: [Text], localObservations :: [Text]
  , reviewer :: Maybe Text, acceptance :: Text, acceptanceEvidence :: [Text]
  , mechanicalEvidence :: [Text] } deriving (Eq,Show)
data MoneyItem = MoneyItem { moneyId :: Text, amount :: Text, moneyEvidenceRef :: Text } deriving (Eq,Show)
data WorkerInput = WorkerInput
  { currency :: Text, cashItems :: [MoneyItem], costItems :: [MoneyItem]
  , cashScope :: Text, releasedHours :: Maybe Text, nonfinancialOutcome :: Maybe Text
  , workerObservation :: Text, allocationPercent :: Maybe Text, commitment :: Text
  , deliveredAmount :: Maybe Text, deliveryEvidence :: [Text]
  , workerEvidence :: [Text] } deriving (Eq,Show)
data FindingStatus = Supported | Unresolved | Contradicted deriving (Eq,Show)
data Finding = Finding
  { findingCode :: Text, findingStatus :: FindingStatus, findingDetail :: Text
  , findingEvidence :: [Text] } deriving (Eq,Show)
data Metric = Metric { metricId :: Text, metricValue :: Rational, metricUnit :: Text }
  deriving (Eq,Show)
data Assessment = Assessment
  { assessmentKind :: Text, classification :: Text, findings :: [Finding]
  , metrics :: [Metric], nextInvestigations :: [Text], limitations :: [Text] }
  deriving (Eq,Show)
data CatalogEntry = CatalogEntry
  { catalogId :: Text, catalogTitle :: Text, catalogConcern :: Text, catalogQuestion :: Text
  , catalogRequiredInputs :: [Text], catalogPrerequisites :: [Text]
  , catalogPossibleFindings :: [Text], catalogLimits :: [Text] } deriving (Eq,Show)
data InventoryEvidence = InventoryEvidence
  { inventoryId :: Text, inventoryOrigin :: Text, inventoryRevision :: Text
  , inventoryObservedAt :: Text, inventoryLimitations :: Text, inventoryReference :: Text
  } deriving (Eq,Show)
data BomLine = BomLine
  { linePosition :: Text, linePartId :: Text, lineRevision :: Text
  , lineQuantity :: Text, lineUnit :: Text, lineEvidenceRef :: Text } deriving (Eq,Show)
data Substitution = Substitution
  { substitutionPosition :: Text, requiredPartId :: Text, substitutionRequiredRevision :: Text
  , actualPartId :: Text, substitutionActualRevision :: Text, quantityFactor :: Text
  , approvalRef :: Text } deriving (Eq,Show)
data WhereUsed = WhereUsed
  { parentId :: Text, parentRevision :: Text, childId :: Text, childRevision :: Text
  , usageConfiguration :: Text, usageEvidence :: Text } deriving (Eq,Show)
data BomInput = BomInput
  { assemblyId :: Text, bomConfiguration :: Text
  , assemblyRequiredRevision :: Maybe Text, assemblyObservedRevision :: Maybe Text
  , bomRelease :: Text, bomEffectivity :: Text, engineeringLines :: [BomLine]
  , manufacturingLines :: [BomLine], substitutions :: [Substitution]
  , selectedPart :: Maybe Text, selectedRevision :: Maybe Text
  , whereUsed :: [WhereUsed], bomEvidence :: [Text] } deriving (Eq,Show)

diagnosticLimits :: [Text]
diagnosticLimits =
  [ "Interpretation of supplied evidence only; source acquisition and provenance are not certified."
  , "This diagnostic grants no access, release, production, payment, or employment authority."
  ]

finding :: [Text] -> Text -> FindingStatus -> Text -> Finding
finding refs code status detail = Finding code status detail refs

result :: Text -> Text -> [Finding] -> [Metric] -> [Text] -> [Text] -> Assessment
result kind category fs ms next limits = Assessment kind category fs ms next (diagnosticLimits <> limits)

-- Reuse the established exact-decimal admission. Ratios remain exact, including
-- nonterminating averages; the wire never rounds them to binary floating point.
decimal :: Text -> Either Text Rational
decimal text = do
  normalized <- canonicalQuantity text
  case T.splitOn "." normalized of
    [whole,fraction] ->
      let digits = T.foldl' (\n c -> n * 10 + fromIntegral (fromEnum c - fromEnum '0')) 0
          scale = 10 ^ T.length fraction
      in Right ((digits whole * scale + digits fraction) % scale)
    _ -> Left "invalid-industrial-decimal"

optionalDecimal :: Maybe Text -> Either Text (Maybe Rational)
optionalDecimal = traverse decimal

validRefs :: [Text] -> Bool
validRefs refs = all (\r -> not (T.null (T.strip r)) && T.length r <= 240 && plainIdentifier r) refs
  && length refs <= 200 && length refs == length (nub refs)

plainIdentifier :: Text -> Bool
plainIdentifier = T.all (\c -> c >= ' ' && c /= toEnum 127)

assess :: Investigation -> Either Text Assessment
assess (Triage input) = assessTriage input
assess (Pdm input) = assessPdm input
assess (Process input) = assessProcess input
assess (Mechanical input) = assessMechanical input
assess (WorkerBenefit input) = assessWorker input
assess (Bom input) = assessBom input

-- The application supplies the inventory captured in the saved case version.
-- Linking a reference is not authentication of the referenced document's content.
assessCase :: Investigation -> [InventoryEvidence] -> Either Text Assessment
assessCase input inventory = do
  let ids = map inventoryId inventory
  if length ids /= length (nub ids) then Left "ambiguous-case-evidence" else pure ()
  if not (validRefs ids) || any ((`notElem` ["synthetic","manual-reference"]) . inventoryOrigin) inventory
    then Left "invalid-case-evidence-inventory" else pure ()
  base <- assess input
  let refs = case input of
        Triage _ -> []
        Pdm x -> pdmEvidence x
        Process x -> processEvidence x
        Mechanical x -> mechanicalEvidence x
        WorkerBenefit x -> workerEvidence x
        Bom x -> bomEvidence x
      used = filter ((`elem` refs) . inventoryId) inventory
      missing = filter (`notElem` ids) refs
      nonblank = not . T.null . T.strip
      incomplete = filter (\e -> not (all nonblank [inventoryReference e,inventoryRevision e,inventoryObservedAt e])) used
      limited = filter (nonblank . inventoryLimitations) used
      qualified = not (null missing) || not (null incomplete) || not (null limited)
      category | not (null missing) = "evidence-linkage-unresolved"
               | not (null incomplete) = "evidence-context-incomplete"
               | not (null limited) = "evidence-limited"
               | otherwise = classification base
      qualify f | qualified && findingStatus f == Supported = f{findingStatus=Unresolved}
                | otherwise = f
      links =
        [finding [ref] ("case-evidence-missing:"<>ref) Unresolved "The assessment reference is absent from the saved case evidence inventory." | ref <- missing]
        <> [finding [inventoryId e] ("case-evidence-incomplete:"<>inventoryId e) Unresolved
              "The linked record needs its reference, revision/version, and observation-time context." | e <- incomplete]
        <> [finding [inventoryId e] ("case-evidence-limitation:"<>inventoryId e) Unresolved
              ("Recorded evidence limitation: "<>inventoryLimitations e) | e <- limited]
  pure base{classification=category,findings=map qualify (findings base)<>links
    ,metrics=if qualified then [] else metrics base
    ,nextInvestigations=(["Resolve the saved case's missing evidence links, context, and stated limitations before relying on the assessment." | qualified]<>nextInvestigations base)
    ,limitations=limitations base<>
      ["Case inventory linkage identifies supplied records; it does not authenticate document content, observation timestamps, or currentness."
      ,"Triage availability labels are declarations of prerequisites, not verification of source coverage."]}

-- The catalog is intentionally finite. Every entry has its own question and
-- prerequisites; it is not an extensible ontology or workflow language.
catalog :: Text -> Maybe (Text,[Text],[Text])
catalog "reporting-discrepancy" = Just
  ("Which source-native definitions and observations explain the reporting difference?"
  ,["native-records","field-definitions","identity-binding","observation-window"]
  ,["Compare the pinned native records and field definitions.","Check identity, coverage, units, and timing before proposing reconciliation."])
catalog "pdm-bom" = Just
  ("Which released definition applies to this product configuration, and did its change reach the point of use?"
  ,["part-identity","released-definition","effectivity","production-bom","point-of-use"]
  ,["Establish applicable configuration and revision.","Trace engineering change, manufacturing BOM, and point-of-use information."])
catalog "flow-setup" = Just
  ("Where are touch, queue, setup, and rework time occurring under comparable conditions?"
  ,["process-boundary","time-observations","product-mix","worker-observation"]
  ,["Observe process steps and distinguish waiting from work.","Compare timing only after defining the measure and sampling context."])
catalog "quality-measurement" = Just
  ("Can the measurement distinguish process variation from measurement variation?"
  ,["requirement","measurement-method","inspection-observations","sampling-plan"]
  ,["Establish measurement suitability and sampling context.","Then investigate process causes with competing explanations."])
catalog "tooling" = Just
  ("Which fixture or tooling requirement fails, and what evidence supports a proposed change?"
  ,["requirement","design-reference","measurement","local-observation"]
  ,["Review requirements, dimensions, tolerances, and inspection method.","Assign qualified design review and local fit/operation checks."])
catalog "layout" = Just
  ("Which layout or movement constraint creates unnecessary effort, delay, or exposure?"
  ,["layout-reference","dimensions","movement-observations","worker-observation"]
  ,["Compare current and proposed movement using observed dimensions and paths.","Record local access, clearance, safety, and operating constraints."])
catalog "maintenance" = Just
  ("Which failure, maintenance delay, or information gap affects reliable operation?"
  ,["asset-identity","failure-history","maintenance-records","worker-observation"]
  ,["Distinguish failure frequency, repair time, waiting, and planned maintenance.","Ask the asset owner to review any proposed operational intervention."])
catalog "reporting-signage" = Just
  ("What decision should this report or sign support, and is its definition and freshness suitable?"
  ,["decision-owner","metric-definition","source-lineage","freshness-requirement"]
  ,["Trace the displayed measure to its source and definition.","Agree the action owner and behavior when information is stale or unavailable."])
catalog _ = Nothing

industrialCatalog :: [CatalogEntry]
industrialCatalog =
  [ CatalogEntry key title concernName question required
      ["Define the bounded question, responsible owners, and actual access authorization."
      ,"Preserve evidence provenance and explicitly unresolved observations."]
      (["measurement-first" | concernName `elem` ["flow-setup","quality-measurement"]]
        <> ["evidence-needed","investigation-ready"])
      (diagnosticLimits <> ["Investigation selection does not establish a cause or improvement outcome."])
  | (key,title,concernName) <-
      [("reporting","Reporting discrepancy","reporting-discrepancy")
      ,("pdm-bom","PDM, BOM, and engineering changes","pdm-bom")
      ,("flow-setup","Process flow and setup","flow-setup")
      ,("quality-measurement","Quality and measurement","quality-measurement")
      ,("tooling","Tooling and fixtures","tooling")
      ,("layout","Layout and movement","layout")
      ,("maintenance","Maintenance investigation","maintenance")
      ,("reporting-signage","Reports and digital signage","reporting-signage")]
  , Just (question,required,_) <- [catalog concernName]
  ]

assessTriage :: TriageInput -> Either Text Assessment
assessTriage input = case catalog (concern input) of
  Nothing -> Left "unsupported-investigation-concern"
  Just (question,required,next) ->
    let needed = nub (required <> ["worker-observation" | workerConcern input])
        gaps = filter (`notElem` availableEvidence input) needed
        measurementFirst = concern input `elem` ["flow-setup","quality-measurement"] && not (measurementReady input)
        category | measurementFirst = "measurement-first"
                 | not (null gaps) = "evidence-needed"
                 | otherwise = "investigation-ready"
        fs = [finding [] "investigation-question" Supported question]
          <> [finding [] ("missing:" <> gap) Unresolved ("Obtain evidence for " <> gap <> ".") | gap <- gaps]
          <> [finding [] "measurement-prerequisite" Unresolved "Establish the measure and its suitability before comparing performance." | measurementFirst]
    in if not (validRefs (availableEvidence input)) then Left "invalid-available-evidence"
       else Right (result "triage" category fs [] next
         ["Investigation readiness is not a causal finding or permission to acquire a source."])

assessPdm :: PdmInput -> Either Text Assessment
assessPdm input = do
  eq <- optionalDecimal (engineeringQuantity input)
  mq <- optionalDecimal (manufacturingQuantity input)
  if not (validRefs refs) then Left "invalid-pdm-evidence" else pure ()
  if identity input `notElem` ["confirmed","unknown","conflicting"] ||
     release input `notElem` ["released","draft","unknown"] ||
     effectivity input `notElem` ["applicable","not-applicable","unknown"]
     then Left "invalid-pdm-state" else pure ()
  let quantityKnown = case (eq,mq,engineeringUnit input,manufacturingUnit input) of
        (Just _,Just _,Just a,Just b) -> not (T.null (T.strip a)) && not (T.null (T.strip b))
        _ -> False
      unitsMatch = quantityKnown && engineeringUnit input == manufacturingUnit input
      revisionKnown = all (maybe False (not . T.null . T.strip)) [requiredRevision input,observedRevision input]
      revisionMatches = revisionKnown && requiredRevision input == observedRevision input
      hasContext = not (T.null (T.strip (partId input))) && not (T.null (T.strip (configuration input)))
      quantityMatches = quantityKnown && unitsMatch && eq == mq
      category
        | identity input == "conflicting" = "conflicting-identity"
        | identity input /= "confirmed" || not hasContext = "identity-unresolved"
        | effectivity input == "unknown" = "effectivity-unresolved"
        | effectivity input == "not-applicable" = "definition-not-applicable"
        | release input /= "released" = "release-unresolved"
        | changeApproved input && changePropagated input == Just False = "change-not-propagated"
        | changeApproved input && changePropagated input == Nothing = "change-propagation-unresolved"
        | null refs || not revisionKnown || not quantityKnown = "evidence-incomplete"
        | not unitsMatch = "unit-mapping-unresolved"
        | not revisionMatches && not (approvedAlternate input) = "revision-mismatch"
        | not quantityMatches = "bom-quantity-mismatch"
        | not revisionMatches = "approved-alternate-recorded"
        | otherwise = "applicable-definition-consistent"
      idStatus | identity input == "conflicting" = Contradicted
               | identity input == "confirmed" && hasContext = Supported
               | otherwise = Unresolved
      applicabilityStatus | effectivity input == "applicable" = Supported
                          | effectivity input == "not-applicable" = Contradicted
                          | otherwise = Unresolved
      revisionStatus | not revisionKnown = Unresolved
                     | revisionMatches || approvedAlternate input = Supported
                     | otherwise = Contradicted
      quantityStatus | not quantityKnown || not unitsMatch = Unresolved
                     | quantityMatches = Supported
                     | otherwise = Contradicted
      fs =
        [ f "part-identity" idStatus "Interpretation is scoped to the supplied part identity and configuration."
        , f "applicability" applicabilityStatus "Applicability comes from explicit effectivity; revision ordering is not used."
        , f "release-state" (if release input == "released" then Supported else Unresolved) "The required definition needs a released source record."
        , f "revision-consistency" revisionStatus "Compare the explicitly required and observed revisions, respecting a recorded approved alternate."
        , f "bom-quantity" quantityStatus "Quantity comparison requires known quantities in the same explicit unit."
        ]
        <> [f "change-propagation" (case changePropagated input of Just True -> Supported; Just False -> Contradicted; Nothing -> Unresolved)
              "An approved engineering change still requires downstream propagation evidence." | changeApproved input]
        <> [f "evidence-presence" Unresolved "No evidence references were supplied." | null refs]
      ms = case (eq,mq,engineeringUnit input) of
        (Just a,Just b,Just u) | unitsMatch && identity input == "confirmed" && effectivity input == "applicable" && not (null refs) ->
          [Metric "manufacturing-minus-engineering-quantity" (b-a) u]
        _ -> []
      next = if category `elem` ["applicable-definition-consistent","approved-alternate-recorded"]
        then ["Confirm the evidence is current and review the point-of-use definition with its owner."]
        else ["Resolve the reported evidence gap with the PDM or engineering-change owner.","Check the applicable BOM and point-of-use instruction before proposing correction."]
  pure (result "pdm" category fs ms next
    ["Recorded identity, applicability, alternate approval, and release state are supplied assertions; this diagnostic does not release or rewrite a product definition."
    ,"This assessment compares one supplied BOM quantity pair. Use the structured BOM assessment for multiple positions and bounded where-used relationships."])
  where refs = pdmEvidence input; f = finding refs

timeFactor :: Text -> Maybe Rational
timeFactor "s" = Just 1
timeFactor "min" = Just 60
timeFactor "h" = Just 3600
timeFactor _ = Nothing

assessProcess :: ProcessInput -> Either Text Assessment
assessProcess input = do
  let before = baseline input; after = followup input; name = measure input
      percentage = name `elem` ["defect-rate","first-pass-yield"]
  if name `notElem` ["cycle","touch","queue","setup","downtime","rework","defect-rate","first-pass-yield"]
    then Left "unsupported-process-measure" else pure ()
  if not (validRefs refs) then Left "invalid-process-evidence" else pure ()
  a <- traverse decimal (samples before)
  b <- traverse decimal (samples after)
  if percentage && any (>100) (a<>b) then Left "quality-percentage-out-of-range" else pure ()
  if length a > 200 || length b > 200 then Left "sample-budget" else pure ()
  let unitValid o = if percentage then observationUnit o == "percent" else timeFactor (observationUnit o) /= Nothing
      basisValid o
        | percentage = basis o == "inspection"
        | name == "cycle" = basis o `elem` ["operator-observation","machine-observation"]
        | name == "touch" = basis o == "operator-observation"
        | otherwise = basis o `elem` ["operator-observation","machine-observation","order-elapsed"]
      contextComplete = all (not . T.null . T.strip)
        [population before,population after,method before,method after,conditions before,conditions after,observationWindow before,observationWindow after]
      comparable = population before == population after && method before == method after && conditions before == conditions after && basis before == basis after
      quality = measurementQuality before == "adequate" && measurementQuality after == "adequate"
      category
        | not (unitValid before && unitValid after) = "incompatible-measure-unit"
        | not (basisValid before && basisValid after) = "measurement-basis-invalid"
        | not quality = "measurement-quality-unresolved"
        | not contextComplete || null a || null b || null refs = "evidence-incomplete"
        | not comparable = "comparison-not-established"
        | otherwise = "descriptive-comparison"
      mean o values = sum values / fromIntegral (length values) *
        (if percentage then 1 else maybe 1 id (timeFactor (observationUnit o)))
      unitName = if percentage then "percent" else "s"
      eligible = category == "descriptive-comparison"
      meanA = if null a then 0 else mean before a
      meanB = if null b then 0 else mean after b
      ms = if eligible then
        [Metric "baseline-mean" meanA unitName,Metric "followup-mean" meanB unitName
        ,Metric "baseline-minus-followup" (meanA-meanB) unitName]
        <> [Metric "relative-reduction-percent" ((meanA-meanB)/meanA*100) "percent" | meanA /= 0]
        else []
      fs = [f "comparison-prerequisites" (if eligible then Supported else Unresolved)
         (if eligible then "The supplied samples satisfy the bounded descriptive comparison prerequisites."
          else "Resolve unit, measurement basis, measurement quality, context, and evidence gaps before comparison.")]
        <> [f "zero-baseline" Unresolved "A percentage change is undefined when the baseline is zero." | eligible && meanA == 0]
        <> [f "small-sample" Unresolved "At least one side has a single observation; no variability or statistical significance is established." | eligible && (length a < 2 || length b < 2)]
  pure (result "process" category fs ms
    (if eligible then ["Review distributions and competing explanations before proposing a causal conclusion."]
      else ["Obtain comparable observations using a suitable, explicitly defined measurement method."])
    ["These are exact descriptive means and differences, not a causal estimate or significance test."
    ,"Percentage samples are equally weighted. Without sample denominators, their mean is not a pooled defect or first-pass-yield rate."
    ,"The reduction metric is baseline minus follow-up; its desirability depends on the chosen measure. Rework denotes rework time."])
  where refs = processEvidence input; f = finding refs

assessMechanical :: MechanicalInput -> Either Text Assessment
assessMechanical input = do
  if mechanicalMode input `notElem` ["tooling","layout","inspection"] || acceptance input `notElem` ["pending","accepted","rejected"]
    then Left "invalid-mechanical-state" else pure ()
  let subsets = [requirements input,designs input,measurements input,localObservations input,acceptanceEvidence input]
  if not (all validRefs (refs:subsets)) || not (all (`elem` refs) (concat subsets))
    then Left "unbound-mechanical-evidence" else pure ()
  let definitionComplete = not (null (requirements input)) && not (null (designs input)) && not (null (measurements input))
      localComplete = not (null (localObservations input))
      reviewerKnown = maybe False (not . T.null . T.strip) (reviewer input)
      acceptanceComplete = reviewerKnown && not (null (acceptanceEvidence input))
      category
        | acceptance input == "rejected" = "acceptance-rejected"
        | not definitionComplete = "evidence-incomplete"
        | not localComplete = "local-verification-pending"
        | acceptance input == "accepted" && acceptanceComplete = "acceptance-recorded"
        | otherwise = "review-pending"
      fs =
        [ f "definition-evidence" (if definitionComplete then Supported else Unresolved) "Requirements, versioned designs, and measurements must all be referenced."
        , f "local-evidence" (if localComplete then Supported else Unresolved) "Remote design review does not replace required local observations."
        , f "acceptance-record" (if category == "acceptance-recorded" then Supported else if category == "acceptance-rejected" then Contradicted else Unresolved)
          "Acceptance remains the responsible reviewer's recorded decision, with evidence; this software does not certify fit, installation, or safe operation."
        ]
  pure (result "mechanical" category fs []
    ["Have the responsible design/quality owner review the stated requirements and inspection method.","Complete and record any remaining local checks before operational acceptance."]
    ["No physical acceptance, safety certification, design approval, or equipment authority is created by this assessment."])
  where refs = mechanicalEvidence input; f = finding refs

assessWorker :: WorkerInput -> Either Text Assessment
assessWorker input = do
  if currency input `notElem` ["USD","EUR","GBP"] || cashScope input `notElem` ["nonoverlapping","unverified"] ||
     workerObservation input `notElem` ["unobserved","observed","disputed"] || commitment input `notElem` ["uncommitted","authorized","revoked"]
    then Left "invalid-worker-benefit-state" else pure ()
  let items = cashItems input <> costItems input; ids = map moneyId items
  if length ids /= length (nub ids) || any (T.null . T.strip) ids then Left "duplicate-benefit-entry" else pure ()
  if length items > 100 then Left "benefit-budget" else pure ()
  if not (validRefs refs) || not (validRefs (deliveryEvidence input)) || not (all (`elem` refs) (deliveryEvidence input))
    then Left "unbound-worker-evidence" else pure ()
  if any (\item -> T.null (T.strip (moneyEvidenceRef item)) || moneyEvidenceRef item `notElem` refs) items
    then Left "unbound-benefit-item-evidence" else pure ()
  cash <- traverse (decimal . amount) (cashItems input)
  costs <- traverse (decimal . amount) (costItems input)
  hours <- optionalDecimal (releasedHours input)
  share <- optionalDecimal (allocationPercent input)
  delivered <- optionalDecimal (deliveredAmount input)
  if maybe False (>100) share then Left "allocation-percent-out-of-range" else pure ()
  let observationKnown = workerObservation input == "observed" && not (null refs)
      itemBasisUnique = length (map moneyEvidenceRef items) == length (nub (map moneyEvidenceRef items))
      cashKnown = observationKnown && cashScope input == "nonoverlapping" && not (null cash) && itemBasisUnique
      net = sum cash - sum costs
      allocatable = max 0 net
      allocationKnown = cashKnown && commitment input == "authorized" && share /= Nothing
      allocation = allocatable * maybe 0 id share / 100
      deliveredKnown = observationKnown && commitment input == "authorized" && delivered /= Nothing && not (null (deliveryEvidence input))
      category
        | workerObservation input == "disputed" = "outcome-disputed"
        | not observationKnown = "outcome-unobserved"
        | commitment input == "revoked" = "commitment-revoked"
        | commitment input == "uncommitted" = "financial-distribution-uncommitted"
        | not allocationKnown = "allocation-unresolved"
        | not deliveredKnown = "delivery-unverified"
        | maybe False (>=allocation) delivered = "delivery-evidence-recorded"
        | otherwise = "delivery-partial"
      ms = [Metric "net-observed-cash" net (currency input) | cashKnown]
        <> [Metric "released-capacity" h "h" | observationKnown,Just h <- [hours]]
        <> [Metric "authorized-allocation" allocation (currency input) | allocationKnown]
        <> [Metric "recorded-delivery" d (currency input) | deliveredKnown,Just d <- [delivered]]
        <> [Metric "remaining-allocation" (max 0 (allocation-d)) (currency input) | allocationKnown && deliveredKnown,Just d <- [delivered]]
      fs =
        [ f "observed-outcome" (if observationKnown then Supported else if workerObservation input == "disputed" then Contradicted else Unresolved)
            "Observed benefits require supporting evidence and remain distinct from proposed benefits."
        , f "cash-attribution" (if cashKnown then Supported else Unresolved)
            "Cash requires an observed, nonoverlapping cash basis; released hours are never converted into cash automatically."
        , f "financial-commitment" (if commitment input == "authorized" then Supported else Unresolved)
            "An authorized financial commitment is distinct from an opportunity or a proposed share."
        , f "delivery-evidence" (if deliveredKnown then Supported else Unresolved)
            "Delivery needs its own evidence and cannot be inferred from a commitment or calculated allocation."
        ]
        <> [f "shared-benefit-basis" Unresolved "Multiple cash/cost entries cite the same evidence item. Resolve their separate attribution before calculating a financial allocation." | not itemBasisUnique]
        <> [f "nonfinancial-outcome" (if observationKnown then Supported else Unresolved) outcome | Just outcome <- [nonfinancialOutcome input], not (T.null (T.strip outcome))]
  pure (result "worker-benefit" category fs ms
    ["Review outcome attribution with affected workers and the responsible owner.","Obtain authorized allocation and delivery evidence where a financial return is intended."]
    ["Exact rational monetary calculations are diagnostic; currency rounding and payment execution remain outside this contract."
    ,"Recorded commitments and delivery evidence do not authorize payroll or establish employment rights."
    ,"Distinct item identifiers do not independently prove nonoverlap; the asserted cash scope requires review."])
  where refs = workerEvidence input; f = finding refs

-- Position identity is explicit within one supplied assembly configuration.
-- This finite comparison does not infer a universal part or unit equivalence.
assessBom :: BomInput -> Either Text Assessment
assessBom input = do
  if not (validRefs refs) then Left "invalid-bom-evidence" else pure ()
  if bomRelease input `notElem` ["released","draft","unknown"] ||
     bomEffectivity input `notElem` ["applicable","not-applicable","unknown"]
    then Left "invalid-bom-context" else pure ()
  erows <- admitLines (engineeringLines input)
  mrows <- admitLines (manufacturingLines input)
  approved <- traverse admitSubstitution (substitutions input)
  if length approved > 200 || length (whereUsed input) > 200 then Left "bom-relationship-budget" else pure ()
  let subKeys = [(substitutionPosition s,requiredPartId s,substitutionRequiredRevision s,actualPartId s,substitutionActualRevision s) | (s,_) <- approved]
  if length subKeys /= length (nub subKeys) then Left "ambiguous-substitution" else pure ()
  let usages = whereUsed input
      usageKeys = [(parentId e,parentRevision e,childId e,childRevision e,usageConfiguration e) | e <- usages]
  if length usageKeys /= length (nub usageKeys) then Left "duplicate-where-used-relationship" else pure ()
  if any (\e -> not (all nonblank [parentId e,parentRevision e,childId e,childRevision e,usageConfiguration e]) || usageEvidence e `notElem` refs) usages
    then Left "unbound-where-used-evidence" else pure ()
  let positions = sort (nub (map (linePosition . fst) (erows<>mrows)))
      comparisons = map (comparePosition approved erows mrows) positions
      lineFindings = concatMap fst comparisons
      lineMetrics = concatMap snd comparisons
      lineConflict = any ((==Contradicted) . findingStatus) lineFindings
      lineUnresolved = any ((==Unresolved) . findingStatus) lineFindings
      (usageFindings,usageMetrics,cycleFound) = assessUsage usages
      revisionKnown = all (maybe False nonblank) [assemblyRequiredRevision input,assemblyObservedRevision input]
      contextKnown = nonblank (assemblyId input) && nonblank (bomConfiguration input)
      contextReady = contextKnown && revisionKnown && assemblyRequiredRevision input == assemblyObservedRevision input && bomRelease input == "released" && bomEffectivity input == "applicable" && not (null refs)
      category
        | not contextKnown || not revisionKnown || null refs = "bom-context-incomplete"
        | bomEffectivity input /= "applicable" = "bom-applicability-unresolved"
        | bomRelease input /= "released" = "bom-release-unresolved"
        | assemblyRequiredRevision input /= assemblyObservedRevision input = "assembly-revision-mismatch"
        | null positions = "bom-lines-empty"
        | cycleFound = "where-used-cycle"
        | lineConflict = "bom-lines-differ"
        | lineUnresolved = "bom-comparison-unresolved"
        | otherwise = "bom-lines-consistent"
      contextFindings =
        [f "assembly-context" (if contextReady then Supported else Unresolved)
          "The comparison is scoped to one explicitly supplied assembly, configuration, release state, and effectivity."
        ,f "assembly-revision" (if not revisionKnown then Unresolved else if assemblyRequiredRevision input == assemblyObservedRevision input then Supported else Contradicted)
          "Parent revision is compared explicitly; the latest revision is never assumed applicable."]
  pure (result "bom" category (contextFindings<>lineFindings<>usageFindings)
    (if contextReady then lineMetrics<>usageMetrics else [])
    ["Review mismatched or missing positions with the engineering and manufacturing definition owners."
    ,"Confirm substitution approvals and each affected parent revision's applicability before proposing an engineering change."]
    ["BOM positions, applicability, release state, and substitution approvals are supplied assertions, not authenticated product-release decisions."
    ,"Where-used results cover only the supplied configuration-specific part/revision relationships; they are not an exhaustive company-wide impact analysis."
    ,"The comparison does not inspect CAD geometry, propagate changes, modify BOMs, or grant a release or production action."])
  where
    refs = bomEvidence input
    f = finding []
    nonblank text = not (T.null (T.strip text)) && T.length text <= 240 && plainIdentifier text
    usageCode p r = "where-used:"<>T.pack (show (T.length p))<>":"<>p<>":"<>T.pack (show (T.length r))<>":"<>r
    admitLines rows = do
      if length rows > 200 then Left "bom-line-budget" else pure ()
      let positions = map linePosition rows
      if length positions /= length (nub positions) then Left "duplicate-bom-position" else pure ()
      traverse (\row -> do
        if not (all nonblank [linePosition row,linePartId row,lineRevision row,lineUnit row]) then Left "incomplete-bom-line" else pure ()
        if lineEvidenceRef row `notElem` refs then Left "unbound-bom-line-evidence" else pure ()
        quantity <- decimal (lineQuantity row)
        pure (row,quantity)) rows
    admitSubstitution sub = do
      if not (all nonblank [substitutionPosition sub,requiredPartId sub,substitutionRequiredRevision sub,actualPartId sub,substitutionActualRevision sub]) || approvalRef sub `notElem` refs
        then Left "unbound-substitution-evidence" else pure ()
      factor <- decimal (quantityFactor sub)
      if factor <= 0 then Left "invalid-substitution-factor" else pure ()
      pure (sub,factor)
    comparePosition approved erows mrows position =
      case (find ((==position) . linePosition . fst) erows,find ((==position) . linePosition . fst) mrows) of
        (Just (e,_),Nothing) -> ([finding [lineEvidenceRef e] ("missing-manufacturing-position:"<>position) Contradicted "This engineering position has no supplied manufacturing BOM line."],[])
        (Nothing,Just (m,_)) -> ([finding [lineEvidenceRef m] ("extra-manufacturing-position:"<>position) Contradicted "This manufacturing position has no supplied engineering BOM line."],[])
        (Just (e,eq),Just (m,mq)) ->
          let sub = find (\(s,_) -> substitutionPosition s == position && requiredPartId s == linePartId e &&
                substitutionRequiredRevision s == lineRevision e && actualPartId s == linePartId m && substitutionActualRevision s == lineRevision m) approved
              samePart = linePartId e == linePartId m
              sameRevision = lineRevision e == lineRevision m
              identityResolved = (samePart && sameRevision) || sub /= Nothing
              unitsMatch = lineUnit e == lineUnit m
              factor = maybe 1 snd sub
              delta = mq-eq*factor
              rf = finding (nub ([lineEvidenceRef e,lineEvidenceRef m]<>maybe [] (\(s,_) -> [approvalRef s]) sub))
              fs =
                [rf ("part-at-position:"<>position) (if samePart || sub /= Nothing then Supported else Contradicted)
                  "Part identity at this position must match or have a supplied, revision-specific substitution approval."]
                <> [rf ("revision-at-position:"<>position) Contradicted "The component revision differs without a matching supplied approval." | samePart && not sameRevision && sub == Nothing]
                <> [rf ("substitution-at-position:"<>position) Supported "The supplied substitution approval matches both part revisions and supplies an explicit quantity factor." | sub /= Nothing]
                <> [rf ("unit-at-position:"<>position) Unresolved "The units differ; this contract does not invent a unit mapping." | not unitsMatch]
                <> [rf ("quantity-at-position:"<>position)
                      (if not identityResolved || not unitsMatch then Unresolved else if delta == 0 then Supported else Contradicted)
                      "Manufacturing quantity is compared with engineering quantity multiplied by the applicable supplied substitution factor."]
              ms = [Metric ("quantity-delta:"<>position) delta (lineUnit e) | identityResolved && unitsMatch]
          in (fs,ms)
        (Nothing,Nothing) -> ([],[])
    assessUsage usages = case (selectedPart input,selectedRevision input) of
      (Nothing,Nothing) -> ([],[],False)
      (Just part,Just rev) | nonblank part && nonblank rev ->
        let selected = (part,rev)
            scoped = filter ((==bomConfiguration input) . usageConfiguration) usages
            parents node = [(parentId e,parentRevision e) | e <- scoped,(childId e,childRevision e)==node]
            visit stack done node
              | node `elem` stack = (done,[],True)
              | node `elem` done = (done,[],False)
              | otherwise =
                  let step (visited,ancestors,cyclic) parent =
                        let (next,up,cycleHere) = visit (node:stack) visited parent
                        in (next,parent:up<>ancestors,cyclic||cycleHere)
                      (visited,ancestors,cyclic) = foldl' step (done,[],False) (parents node)
                  in (node:visited,ancestors,cyclic)
            (_,found,cyclic) = visit [] [] selected
            ancestors = sort (filter (/=selected) (nub found))
            fs = [finding (nub [usageEvidence e | e <- scoped,parentId e==p,parentRevision e==r]) (usageCode p r) Supported
                    ("The supplied relationships connect the selected part revision to parent "<>p<>" revision "<>r<>" in configuration "<>bomConfiguration input<>".") | (p,r) <- ancestors]
              <> [f "where-used-empty" Unresolved "No supplied relationship establishes an ancestor for this selected part revision and configuration." | null ancestors]
              <> [f "where-used-cycle" Contradicted "The supplied revision-specific where-used relationships contain a cycle." | cyclic]
            ms = [Metric "supplied-where-used-ancestor-count" (fromIntegral (length ancestors)) "assembly-revisions"]
        in (fs,ms,cyclic)
      _ -> ([f "where-used-selection" Unresolved "Select both a part identity and its revision for bounded where-used analysis."],[],False)

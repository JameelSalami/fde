{-# LANGUAGE OverloadedStrings #-}
module FDE.IndustrialWire (processIndustrial,parseIndustrial,renderAssessment,renderCatalog) where
import Control.Monad (unless)
import Data.Aeson (Value(..),object,withObject,(.:),(.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser,parseEither)
import Data.List (sort)
import Data.Ratio (numerator,denominator)
import Data.Text (Text)
import qualified Data.Text as T
import FDE.Industrial

exact :: [Text] -> KM.KeyMap Value -> Parser ()
exact names obj = unless (sort (map Key.toText (KM.keys obj)) == sort names)
  (fail "closed-industrial-schema")

oneOf :: [Text] -> Text -> Parser Text
oneOf values x = if x `elem` values then pure x else fail "unsupported-industrial-value"

bounded :: Text -> Parser Text
bounded t = if T.length t <= 4000 then pure t else fail "industrial-text-budget"

txt :: KM.KeyMap Value -> Key.Key -> Parser Text
txt obj key = obj .: key >>= bounded

maybeText :: KM.KeyMap Value -> Key.Key -> Parser (Maybe Text)
maybeText obj key = (obj .: key :: Parser (Maybe Text)) >>= traverse bounded

texts :: KM.KeyMap Value -> Key.Key -> Parser [Text]
texts obj key = do
  xs <- obj .: key
  unless (length xs <= 200) (fail "industrial-array-budget")
  traverse bounded xs

tag :: KM.KeyMap Value -> Key.Key -> [Text] -> Parser Text
tag obj key allowed = obj .: key >>= oneOf allowed

observation :: Value -> Parser Observation
observation = withObject "process observation" $ \o -> do
  exact ["samples","unit","population","method","basis","conditions","window","measurementQuality"] o
  Observation <$> texts o "samples"
    <*> tag o "unit" ["s","min","h","percent"]
    <*> txt o "population" <*> txt o "method"
    <*> tag o "basis" ["operator-observation","machine-observation","order-elapsed","inspection"]
    <*> txt o "conditions" <*> txt o "window"
    <*> tag o "measurementQuality" ["adequate","unknown","inadequate"]

moneyItem :: Value -> Parser MoneyItem
moneyItem = withObject "money item" $ \o -> do
  exact ["id","amount","evidenceRef"] o
  MoneyItem <$> txt o "id" <*> txt o "amount" <*> txt o "evidenceRef"

moneyItems :: KM.KeyMap Value -> Key.Key -> Parser [MoneyItem]
moneyItems o key = do
  xs <- o .: key
  unless (length xs <= 100) (fail "money-item-budget")
  traverse moneyItem xs

inventoryEvidence :: Value -> Parser InventoryEvidence
inventoryEvidence = withObject "case inventory evidence" $ \o -> do
  exact ["id","origin","revision","observedAt","limitations","reference"] o
  InventoryEvidence <$> txt o "id" <*> tag o "origin" ["synthetic","manual-reference"]
    <*> txt o "revision" <*> txt o "observedAt" <*> txt o "limitations" <*> txt o "reference"

bomLine :: Value -> Parser BomLine
bomLine = withObject "BOM line" $ \o -> do
  exact ["position","partId","revision","quantity","unit","evidenceRef"] o
  BomLine <$> txt o "position" <*> txt o "partId" <*> txt o "revision" <*> txt o "quantity" <*> txt o "unit" <*> txt o "evidenceRef"

substitution :: Value -> Parser Substitution
substitution = withObject "BOM substitution" $ \o -> do
  exact ["position","requiredPartId","requiredRevision","actualPartId","actualRevision","quantityFactor","approvalRef"] o
  Substitution <$> txt o "position" <*> txt o "requiredPartId" <*> txt o "requiredRevision"
    <*> txt o "actualPartId" <*> txt o "actualRevision" <*> txt o "quantityFactor" <*> txt o "approvalRef"

usage :: Value -> Parser WhereUsed
usage = withObject "where-used relationship" $ \o -> do
  exact ["parentId","parentRevision","childId","childRevision","configuration","evidenceRef"] o
  WhereUsed <$> txt o "parentId" <*> txt o "parentRevision" <*> txt o "childId" <*> txt o "childRevision"
    <*> txt o "configuration" <*> txt o "evidenceRef"

objects :: KM.KeyMap Value -> Key.Key -> (Value -> Parser a) -> Parser [a]
objects o key parser = do
  xs <- o .: key
  unless (length xs <= 200) (fail "industrial-array-budget")
  traverse parser xs

investigation :: Value -> Parser Investigation
investigation = withObject "industrial investigation" $ \o -> do
  kind <- o .: "kind" :: Parser Text
  case kind of
    "triage" -> do
      exact ["kind","concern","availableEvidence","measurementReady","workerConcern"] o
      Triage <$> (TriageInput
        <$> tag o "concern" ["reporting-discrepancy","pdm-bom","flow-setup","quality-measurement","tooling","layout","maintenance","reporting-signage"]
        <*> texts o "availableEvidence" <*> o .: "measurementReady" <*> o .: "workerConcern")
    "pdm" -> do
      exact ["kind","partId","configuration","requiredRevision","observedRevision","identity","release","effectivity","approvedAlternate","changeApproved","changePropagated","engineeringQuantity","manufacturingQuantity","engineeringUnit","manufacturingUnit","evidenceRefs"] o
      Pdm <$> (PdmInput <$> txt o "partId" <*> txt o "configuration"
        <*> maybeText o "requiredRevision" <*> maybeText o "observedRevision"
        <*> tag o "identity" ["confirmed","unknown","conflicting"]
        <*> tag o "release" ["released","draft","unknown"]
        <*> tag o "effectivity" ["applicable","not-applicable","unknown"]
        <*> o .: "approvedAlternate" <*> o .: "changeApproved" <*> o .: "changePropagated"
        <*> maybeText o "engineeringQuantity" <*> maybeText o "manufacturingQuantity"
        <*> maybeText o "engineeringUnit" <*> maybeText o "manufacturingUnit"
        <*> texts o "evidenceRefs")
    "bom" -> do
      exact ["kind","assemblyId","configuration","requiredRevision","observedRevision","release","effectivity","engineeringLines","manufacturingLines","substitutions","selectedPart","selectedRevision","whereUsed","evidenceRefs"] o
      Bom <$> (BomInput <$> txt o "assemblyId" <*> txt o "configuration"
        <*> maybeText o "requiredRevision" <*> maybeText o "observedRevision"
        <*> tag o "release" ["released","draft","unknown"]
        <*> tag o "effectivity" ["applicable","not-applicable","unknown"]
        <*> objects o "engineeringLines" bomLine <*> objects o "manufacturingLines" bomLine
        <*> objects o "substitutions" substitution <*> maybeText o "selectedPart" <*> maybeText o "selectedRevision"
        <*> objects o "whereUsed" usage <*> texts o "evidenceRefs")
    "process" -> do
      exact ["kind","measure","baseline","followup","evidenceRefs"] o
      before <- o .: "baseline" >>= observation
      after <- o .: "followup" >>= observation
      Process <$> (ProcessInput
        <$> tag o "measure" ["cycle","touch","queue","setup","downtime","rework","defect-rate","first-pass-yield"]
        <*> pure before <*> pure after <*> texts o "evidenceRefs")
    "mechanical" -> do
      exact ["kind","mode","requirements","designs","measurements","localObservations","reviewer","acceptance","acceptanceEvidence","evidenceRefs"] o
      Mechanical <$> (MechanicalInput
        <$> tag o "mode" ["tooling","layout","inspection"]
        <*> texts o "requirements" <*> texts o "designs" <*> texts o "measurements"
        <*> texts o "localObservations" <*> maybeText o "reviewer"
        <*> tag o "acceptance" ["pending","accepted","rejected"]
        <*> texts o "acceptanceEvidence" <*> texts o "evidenceRefs")
    "worker-benefit" -> do
      exact ["kind","currency","cashItems","costItems","cashScope","releasedHours","nonfinancialOutcome","observation","allocationPercent","commitment","deliveredAmount","deliveryEvidence","evidenceRefs"] o
      WorkerBenefit <$> (WorkerInput
        <$> tag o "currency" ["USD","EUR","GBP"]
        <*> moneyItems o "cashItems" <*> moneyItems o "costItems"
        <*> tag o "cashScope" ["nonoverlapping","unverified"]
        <*> maybeText o "releasedHours" <*> maybeText o "nonfinancialOutcome"
        <*> tag o "observation" ["unobserved","observed","disputed"]
        <*> maybeText o "allocationPercent"
        <*> tag o "commitment" ["uncommitted","authorized","revoked"]
        <*> maybeText o "deliveredAmount" <*> texts o "deliveryEvidence" <*> texts o "evidenceRefs")
    _ -> fail "unsupported-industrial-investigation"

parseIndustrial :: Value -> Either Text Investigation
parseIndustrial value = case parseEither parser value of
  Left _ -> Left "invalid-industrial-request"
  Right input -> Right input
  where
    parser = withObject "industrial request" $ \o -> do
      exact ["schema","investigation"] o
      _ <- tag o "schema" ["fde.industrial-assessment-request/v1"]
      o .: "investigation" >>= investigation

processIndustrial :: Value -> Either Text Value
processIndustrial candidate@(Object o)
  | KM.lookup "schema" o == Just (String "fde.industrial-case-assessment-request/v1") =
      case parseEither parser candidate of
        Left _ -> Left "invalid-industrial-case-request"
        Right (raw,inventory) -> renderAssessment <$> (parseIndustrial raw >>= (`assessCase` inventory))
      where
        parser = withObject "industrial case request" $ \obj -> do
          exact ["schema","request","evidenceInventory"] obj
          raw <- obj .: "request"
          inventory <- obj .: "evidenceInventory"
          unless (length inventory <= 200) (fail "case-evidence-budget")
          (,) raw <$> traverse inventoryEvidence inventory
processIndustrial candidate@(Object o)
  | KM.lookup "schema" o == Just (String "fde.industrial-catalog-request/v1") =
      case parseEither (withObject "industrial catalog request" (exact ["schema"])) candidate of
        Left _ -> Left "invalid-industrial-request"
        Right () -> Right renderCatalog
processIndustrial candidate = renderAssessment <$> (parseIndustrial candidate >>= assess)

renderCatalog :: Value
renderCatalog = object
  [ "schema" .= ("fde.industrial-catalog/v1" :: Text)
  , "authority" .= ("none" :: Text)
  , "entries" .= map entry industrialCatalog ]
  where
    entry e = object
      [ "id" .= catalogId e, "title" .= catalogTitle e, "concern" .= catalogConcern e
      , "question" .= catalogQuestion e, "requiredInputs" .= catalogRequiredInputs e
      , "prerequisites" .= catalogPrerequisites e, "possibleFindings" .= catalogPossibleFindings e
      , "limits" .= catalogLimits e ]

renderAssessment :: Assessment -> Value
renderAssessment a = object
  [ "schema" .= ("fde.industrial-assessment/v1" :: Text)
  , "kind" .= assessmentKind a
  , "classification" .= classification a
  , "findings" .= map renderFinding (findings a)
  , "metrics" .= map renderMetric (metrics a)
  , "nextInvestigations" .= nextInvestigations a
  , "limitations" .= limitations a
  , "authority" .= ("none" :: Text)
  , "vendorWriteAllowed" .= False
  , "physicalAcceptanceCertified" .= False
  ]
  where
    renderFinding f = object
      [ "code" .= findingCode f
      , "status" .= status (findingStatus f)
      , "detail" .= findingDetail f
      , "evidenceRefs" .= findingEvidence f ]
    status Supported = "supported" :: Text
    status Unresolved = "unresolved"
    status Contradicted = "contradicted"
    renderMetric m = object
      [ "id" .= metricId m
      , "numerator" .= T.pack (show (numerator (metricValue m)))
      , "denominator" .= T.pack (show (denominator (metricValue m)))
      , "unit" .= metricUnit m ]

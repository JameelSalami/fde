{-# LANGUAGE OverloadedStrings #-}
module FDE.ProductionReport
  (ProductionInput(..), Loss(..), ProductionResult(..), ParetoRow(..),
   assessProduction, renderProduction) where
import Data.Aeson (Value,object,(.=))
import Data.Char (isAlphaNum,isAscii)
import Data.List (sortBy)
import Data.Ord (comparing,Down(..))
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T

data Loss=Loss {lossId::Text,lossUnits::Integer} deriving (Eq,Show)
data ProductionInput=ProductionInput
  {periodId::Text,lineId::Text,sourceClass::Text,plannedUnits::Integer,
   goodUnits::Integer,lossCategories::[Loss]} deriving (Eq,Show)
data ParetoRow=ParetoRow
  {paretoId::Text,paretoUnits::Integer,paretoShareBps::Integer,
   paretoCumulativeBps::Integer} deriving (Eq,Show)
data ProductionResult=ProductionResult
  {resultPeriod::Text,resultLine::Text,resultSourceClass::Text,
   resultPlanned::Integer,resultGood::Integer,resultShortfall::Integer,
   resultLossTotal::Integer,resultUnclassified::Integer,
   resultAttainmentBps::Maybe Integer,resultLossStatus::Text,
   resultPareto::[ParetoRow]} deriving (Eq,Show)

maxSafe::Integer
maxSafe=9007199254740991
validId::Text->Bool
validId s=not (T.null s) && T.length s<=80 &&
  T.all (\c->isAscii c && (isAlphaNum c || elem c ("_-."::String))) s
nonnegative::Integer->Bool
nonnegative n=n>=0 && n<=maxSafe
basisPoints::Integer->Integer->Integer
basisPoints numerator denominator=div (20000*numerator+denominator) (2*denominator)

assessProduction::ProductionInput->Either Text ProductionResult
assessProduction input
  | not (validId (periodId input) && validId (lineId input))=Left "invalid-report-dimension"
  | not (elem (sourceClass input) ["handwritten-fixture","synthetic-worksheet","manual-export"])=
     Left "unsupported-report-source-class"
  | not (nonnegative (plannedUnits input) && nonnegative (goodUnits input)) ||
     goodUnits input>plannedUnits input=Left "invalid-planned-or-good-quantity"
  | length losses>32 || any (not . validId . lossId) losses ||
     any (not . nonnegative . lossUnits) losses ||
     Set.size (Set.fromList (map lossId losses))/=length losses=
     Left "invalid-or-duplicate-loss-category"
  | total>maxSafe=Left "loss-total-overflow"
  | otherwise=Right ProductionResult
      {resultPeriod=periodId input,resultLine=lineId input,
       resultSourceClass=sourceClass input,
       resultPlanned=plannedUnits input,resultGood=goodUnits input,
       resultShortfall=shortfall,resultLossTotal=total,
       resultUnclassified=max 0 (shortfall-total),
       resultAttainmentBps=if plannedUnits input==0 then Nothing
         else Just (basisPoints (goodUnits input) (plannedUnits input)),
       resultLossStatus=if plannedUnits input==0 then "unknown-plan"
         else if total==shortfall then "reconciled"
         else if total<shortfall then "incomplete-loss-categories"
         else "loss-categories-exceed-gap",
       resultPareto=pareto}
  where
    losses=lossCategories input
    shortfall=plannedUnits input-goodUnits input
    total=sum (map lossUnits losses)
    ranked=sortBy (comparing (\x->(Down (lossUnits x),lossId x))) losses
    cumulative=drop 1 (scanl (+) 0 (map lossUnits ranked))
    pareto=[ParetoRow (lossId l) (lossUnits l)
       (if total==0 then 0 else basisPoints (lossUnits l) total)
       (if total==0 then 0 else basisPoints acc total)
       | (l,acc)<-zip ranked cumulative]
formatPercent::Integer->Text
formatPercent bps=T.pack (show whole++"."++(if remainder<10 then "0" else "")++show remainder)
  where (whole,remainder)=quotRem bps 100

renderProduction::ProductionResult->Value
renderProduction r=object
  ["schema".=("fde.production-kpi-result/v1"::Text),
   "authority".=("non-authoritative-diagnostic"::Text),
   "sourceWriteAllowed".=False,
   "periodId".=resultPeriod r,"lineId".=resultLine r,
   "sourceClass".=resultSourceClass r,
   "plannedUnits".=show (resultPlanned r),"goodUnits".=show (resultGood r),
   "shortfallUnits".=show (resultShortfall r),
   "lossTotalUnits".=show (resultLossTotal r),
   "unclassifiedUnits".=show (resultUnclassified r),
   "attainmentPercent".=fmap formatPercent (resultAttainmentBps r),
   "lossStatus".=resultLossStatus r,
   "pareto".=map row (resultPareto r),
   "limitations".=
       (["Source rows are human-exported or synthetic, not refreshed by this request.",
         "Loss reasons require nonoverlapping unit-equivalent classification.",
         "Attainment is a project ratio, not OEE, first-pass yield or physical output.",
         "Pareto ranking is descriptive; causes, savings and approvals require engineering review."]::[Text])]
  where
    row x=object
      ["id".=paretoId x,"units".=show (paretoUnits x),
       "sharePercent".=(if resultLossTotal r==0 then Nothing else Just (formatPercent (paretoShareBps x))),
       "cumulativePercent".=(if resultLossTotal r==0 then Nothing else Just (formatPercent (paretoCumulativeBps x)))]

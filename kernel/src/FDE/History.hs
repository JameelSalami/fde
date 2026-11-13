-- Pure witness-path composition. Never infers business events or source authority.
module FDE.History
 (Edge(..),Path(..),PredecessorResult(..), admitPath, thenPaths, eitherPaths, predecessors)
where
import Data.List (nub,sort)

data Edge = Edge
  { edgeId :: String, owner :: String, before :: String, after :: String
  , cause :: String, evidenceId :: String
  } deriving (Eq,Ord,Show)

data Path = Path
  { initial :: String, terminal :: String, edges :: [Edge]
  } deriving (Eq,Ord,Show)

data PredecessorResult
  = Unestablished | Inconsistent | ConditionalUnique Path | Alternatives [Path]
  deriving (Eq,Show)

admitPath :: Path -> Either String Path
admitPath p
  | length (edges p) > 20 = Left "too-many-causes"
  | null (initial p) || null (terminal p) = Left "empty-state"
  | null (edges p) && initial p /= terminal p = Left "missing-edge"
  | length (nub (map edgeId (edges p))) /= length (edges p) = Left "duplicate-edge-id"
  | any invalid (edges p) = Left "unwitnessed-edge"
  | otherwise = case edges p of
      [] -> Right p
      (first:rest)
        | before first /= initial p ||
          after (foldl (\_ next -> next) first rest) /= terminal p ->
            Left "terminal-mismatch"
        | or (zipWith (\previous next -> after previous /= before next)
              (first:rest) rest) -> Left "causal-discontinuity"
        | otherwise -> Right p
  where
    invalid e = any null [edgeId e,owner e,before e,after e,cause e,evidenceId e]

distinct :: [Path] -> Either String [Path]
distinct paths
  | length paths > 64 = Left "too-many-alternatives"
  | otherwise = sort . nub <$> traverse admitPath paths

eitherPaths :: [Path] -> [Path] -> Either String [Path]
eitherPaths left right = distinct (left ++ right)

thenPaths :: [Path] -> [Path] -> Either String [Path]
thenPaths l r
  | length l * length r > 64 = Left "composition-capacity"
  | otherwise = do
      left <- distinct l
      right <- distinct r
      distinct
        [Path (initial a) (terminal b) (edges a ++ edges b)
         | a <- left,b <- right,terminal a == initial b]

-- Only exact supplied causes; missing history and source completeness remain distinct.
predecessors :: Bool -> String -> [Path] -> Either String PredecessorResult
predecessors complete wanted raw = do
  ps <- distinct raw
  let eligible = filter (\p -> terminal p == wanted) ps
  pure $ case eligible of
    [] | complete -> Inconsistent
    [] -> Unestablished
    [one] | complete -> ConditionalUnique one
    [_] -> Unestablished
    many -> Alternatives many
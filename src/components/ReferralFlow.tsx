import type { ReferralPerson, ReferralTree } from "../services/account-api";

// A small node in the referral flow: the person's initial, their name, their
// username and which level of the tree they belong to.
function Node({ person, level }: { person: ReferralPerson; level: 1 | 2 }) {
  return (
    <div className={`referral-node referral-node--level-${level}`}>
      <span className="referral-node__avatar" aria-hidden="true">{person.name.charAt(0).toUpperCase() || "U"}</span>
      <span className="referral-node__text">
        <strong>{person.name}</strong>
        <small>@{person.username}</small>
      </span>
      <span className="referral-node__level" aria-hidden="true">L{level}</span>
    </div>
  );
}

interface ReferralFlowProps {
  tree: ReferralTree;
  ownName: string;
  ownCode: string;
}

// The referral network as a flow: you at the top, one arrow per person you
// invited, and from each of those boxes the people they invited. It is a plain
// nested list with CSS connectors, so it reflows instead of cropping on a phone.
export default function ReferralFlow({ tree, ownName, ownCode }: ReferralFlowProps) {
  const childrenOf = (code: string) => tree.level2.filter((child) => child.referredBy === code);
  return (
    <div className="referral-flow" role="group" aria-label="Referral flow">
      <div className="referral-node referral-node--root">
        <span className="referral-node__avatar" aria-hidden="true">{ownName.charAt(0).toUpperCase() || "Y"}</span>
        <span className="referral-node__text">
          <strong>{ownName} (you)</strong>
          <small>{ownCode}</small>
        </span>
        <span className="referral-node__level" aria-hidden="true">You</span>
      </div>
      <ul className="referral-flow__level">
        {tree.direct.map((person) => {
          const children = childrenOf(person.referralCode);
          return (
            <li key={person.referralCode} className="referral-flow__item">
              <span className="referral-flow__head" aria-hidden="true" />
              <Node person={person} level={1} />
              {children.length > 0 && (
                <ul className="referral-flow__level">
                  {children.map((child) => (
                    <li key={child.referralCode} className="referral-flow__item">
                      <span className="referral-flow__head" aria-hidden="true" />
                      <Node person={child} level={2} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

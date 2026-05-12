import React, { useEffect, useState } from "react";

export default function UserProfile({
  userId,
  actions = [],
  theme = "dark",
}) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const canEdit = actions.includes("edit");
  const canDelete = actions.includes("delete");

  const getUserData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/v3/users/${userId}`);

      if (!response.ok) {
        throw new Error("User request failed");
      }

      const data = await response.json();

      setUser({
        ...data,
        fullName: `${data.firstName} ${data.lastName}`,
        initials: `${data.firstName?.[0] || ""}${data.lastName?.[0] || ""}`,
      });

      setLastUpdated(new Date().toISOString());
    } catch (err) {
      console.error("User loading failed", err);
      setError("Unable to load user profile");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (userId) {
      getUserData();
    }
  }, [userId]);

  const handleUpdateClick = () => {
    if (!canEdit) {
      alert("Missing edit permission");
      return;
    }

    console.log("Updating user profile...", userId);
  };

  const handleDeleteClick = async () => {
    if (!canDelete) {
      alert("Missing delete permission");
      return;
    }

    console.log("Deleting user...", userId);
  };

  if (loading) {
    return <div className="loading-state">Loading profile...</div>;
  }

  if (error) {
    return <div className="error-state">{error}</div>;
  }

  if (!user) {
    return <div>No user data found</div>;
  }

  return (
    <div className={`user-profile theme-${theme}`}>
      <div className="header">
        <div className="avatar">
          {user.initials}
        </div>

        <div>
          <h1>{user.fullName}</h1>
          <p>{user.email}</p>
        </div>
      </div>

      <p>Role: {user.role}</p>

      {user.isVerified && (
        <p className="verified-badge">
          Verified account
        </p>
      )}

      {lastUpdated && (
        <small>
          Last updated: {lastUpdated}
        </small>
      )}

      <div className="actions">
        {canEdit && (
          <button onClick={handleUpdateClick}>
            Update User
          </button>
        )}

        {canDelete && (
          <button onClick={handleDeleteClick}>
            Delete User
          </button>
        )}
      </div>
    </div>
  );
}
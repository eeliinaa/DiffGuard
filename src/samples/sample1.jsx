import React, { useEffect, useState } from "react";

export default function UserProfile({ userId, isAdmin, theme = "light" }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getUserData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/v2/users/${userId}`);

      if (!response.ok) {
        throw new Error("User fetch failed");
      }

      const data = await response.json();

      // changed: normalize structure
      setUser({
        ...data,
        fullName: `${data.firstName} ${data.lastName}`,
      });
    } catch (err) {
      console.error("Failed to load user", err);
      setError("Failed to load user data");
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
    if (!isAdmin) {
      alert("Access denied: admin only action");
      return;
    }

    console.log("Updating user profile...", userId);
  };

  const handleDeleteClick = () => {
    if (!isAdmin) {
      alert("Access denied: admin only action");
      return;
    }

    console.log("Deleting user...", userId);
  };

  if (loading) {
    return <div className="loading">Loading user...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  if (!user) {
    return <div>No user found</div>;
  }

  return (
    <div className={`user-profile theme-${theme}`}>
      <h1>{user.fullName}</h1>

      <p>Email: {user.email}</p>
      <p>Role: {user.role}</p>

      {user.isVerified && <p className="verified">Verified user</p>}

      {isAdmin && (
        <div className="actions">
          <button onClick={handleUpdateClick}>
            Update User
          </button>

          <button onClick={handleDeleteClick}>
            Delete User
          </button>
        </div>
      )}
    </div>
  );
}